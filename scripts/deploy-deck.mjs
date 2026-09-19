#!/usr/bin/env node
/**
 * Remote-deploy a SpeechToDeck plugin zip to the Steam Deck and hot-reload the
 * plugin backend through the Decky loader WebSocket API — no manual
 * uninstall/install round-trip in the Decky UI.
 *
 * Why this is safe while the plugin is running: the backend daemon execs a copy
 * of the runtime binary from the plugin's data dir (update-safe execution), and
 * CPython does not hold imported .py files open, so overwriting the plugin
 * directory cannot hit "Text file busy". The reload then restarts the backend
 * process, which picks up the new code.
 *
 * Usage:
 *   node scripts/deploy-deck.mjs --zip <local-path-or-URL> [--host steamdeck] [--plugin SpeechToDeck]
 *
 * After a deploy that changed frontend code, close and reopen the QAM panel so
 * Steam's CEF re-imports the plugin module.
 *
 * ONE-TIME SETUP (deck terminal): the Decky loader extracts plugins as root, so
 * an ssh deploy as user `deck` can only overwrite a deck-owned directory. Run
 * once:  sudo chown -R deck:deck ~/homebrew/plugins/SpeechToDeck
 * (Repeated only if you ever install a zip through the Decky UI again, which
 * re-creates root-owned files.)
 */

import { spawn, execFileSync } from "node:child_process";

const CALL = 0; // decky_loader wsrouter MessageType.CALL
const REPLY = 1; // MessageType.REPLY
const ERROR = -1; // MessageType.ERROR
const DECK_ZIP = "SpeechToDeck-deploy.zip";

function parseArgs(argv) {
    const args = { host: "steamdeck", plugin: "SpeechToDeck" };
    for (let i = 2; i < argv.length; i += 1) {
        if (argv[i] === "--zip") args.zip = argv[i + 1];
        else if (argv[i] === "--host") args.host = argv[i + 1];
        else if (argv[i] === "--plugin") args.plugin = argv[i + 1];
    }
    if (!args.zip) {
        console.error(
            "usage: node scripts/deploy-deck.mjs --zip <local-path-or-URL> [--host steamdeck] [--plugin SpeechToDeck]",
        );
        process.exit(2);
    }
    return args;
}

function run(cmd, args, opts = {}) {
    return execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...opts,
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForToken(port, tries = 30) {
    for (let i = 0; i < tries; i += 1) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/auth/token`);
            if (res.ok) return (await res.text()).trim();
        } catch {
            // tunnel not ready yet
        }
        await sleep(400);
    }
    throw new Error("decky loader tunnel did not come up");
}

function wsCall(port, token, route, args, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?auth=${encodeURIComponent(token)}`);
        const timer = setTimeout(() => {
            try {
                ws.close();
            } catch {
                /* already closed */
            }
            reject(new Error(`websocket call ${route} timed out`));
        }, timeoutMs);
        ws.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new Error("websocket connection failed"));
        });
        ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: CALL, id: 1, route, args }));
        });
        ws.addEventListener("message", (ev) => {
            const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
            if (msg.type === REPLY || msg.type === ERROR) {
                clearTimeout(timer);
                try {
                    ws.close();
                } catch {
                    /* already closed */
                }
                if (msg.type === ERROR)
                    reject(new Error(`loader error: ${JSON.stringify(msg.error)}`));
                else resolve(msg.result);
            }
        });
    });
}

async function main() {
    const { zip, host, plugin } = parseArgs(process.argv);
    const isUrl = /^https?:\/\//.test(zip);

    console.log(`[1/4] placing zip on ${host}…`);
    if (isUrl) {
        run("ssh", [host, `curl -fsSL -o ~/Downloads/${DECK_ZIP} '${zip}'`]);
    } else {
        run("scp", [zip, `${host}:Downloads/${DECK_ZIP}`]);
    }

    console.log("[2/4] overwriting plugin directory…");
    try {
        run("ssh", [host, `unzip -o ~/Downloads/${DECK_ZIP} -d ~/homebrew/plugins/`]);
    } catch (err) {
        if (/Permission denied/i.test(String(err.message))) {
            console.error(
                "The plugin directory is root-owned (Decky UI installs extract as root).\n" +
                    "Fix once on the deck (Konsole), then rerun:\n" +
                    `  sudo chown -R deck:deck ~/homebrew/plugins/${plugin}`,
            );
        }
        throw err;
    }

    console.log("[3/4] reloading plugin backend via decky loader…");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const tunnel = spawn("ssh", ["-N", "-L", `${port}:127.0.0.1:1337`, host], { stdio: "ignore" });
    try {
        const token = await waitForToken(port);
        await wsCall(port, token, "loader/reload_plugin", [plugin]);
        console.log("      backend reload requested");
    } finally {
        tunnel.kill("SIGTERM");
    }

    console.log("[4/4] verifying…");
    const version = run("ssh", [
        host,
        `grep -o '"version": "[^"]*"' ~/homebrew/plugins/${plugin}/plugin.json | head -1`,
    ]).trim();
    console.log(`      deployed ${version}`);
    console.log("done. If this deploy changed frontend code, close and reopen the QAM panel once.");
}

main().catch((err) => {
    console.error(`deploy failed: ${err.message}`);
    process.exit(1);
});
