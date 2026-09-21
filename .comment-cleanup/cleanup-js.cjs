const fs = require('node:fs');
const cp = require('node:child_process');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
const files = cp.execFileSync('git', ['ls-files', '-z'], {encoding:'utf8'}).split('\0').filter(p => /\.(?:[cm]?js|tsx?)$/.test(p));
const report = [];
function sourceFile(path, text) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw new Error(`${path}: ${source.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n')}`);
    return source;
}
function comments(source) {
    const found = new Map();
    const add = (ranges) => { for (const range of ranges || []) found.set(range.pos, range); };
    const visit = (node) => {
        add(ts.getLeadingCommentRanges(source.text, node.pos));
        add(ts.getTrailingCommentRanges(source.text, node.end));
        for (const child of node.getChildren(source)) visit(child);
    };
    visit(source);
    return [...found.values()].sort((a,b) => a.pos - b.pos);
}
function tokens(source) {
    const result = [];
    const visit = node => {
        if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
        const children = node.getChildren(source);
        if (children.length === 0 && node.kind !== ts.SyntaxKind.EndOfFileToken) result.push([node.kind, node.getText(source)]);
        else for (const child of children) visit(child);
    };
    visit(source);
    return JSON.stringify(result);
}
function erase(text, ranges) {
    let next = text;
    for (const range of [...ranges].reverse()) next = next.slice(0, range.pos) + next.slice(range.pos, range.end).replace(/[^\r\n]/g, ' ') + next.slice(range.end);
    const oldLines = text.split('\n');
    return next.split('\n').flatMap((line, index) => {
        if (line.trim() === '' && oldLines[index].trim() !== '') return [];
        return [line !== oldLines[index] ? line.trimEnd() : line];
    }).join('\n').replace(/^\n+/, '');
}
for (const path of files) {
    const before = fs.readFileSync(path, 'utf8');
    const parsed = sourceFile(path, before);
    const ranges = comments(parsed);
    const after = erase(before, ranges);
    const changed = sourceFile(path, after);
    if (tokens(parsed) !== tokens(changed)) throw new Error(`${path}: token sequence changed`);
    if (comments(changed).length) throw new Error(`${path}: comments remain`);
    if (after !== before) fs.writeFileSync(path, after);
    report.push({path, comments: ranges.length, commentLines: ranges.reduce((n,r) => n + before.slice(r.pos,r.end).split('\n').length, 0), tokenParity: true});
}
fs.writeFileSync(process.env.JS_REPORT || '/tmp/comment-cleanup-js.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({files: files.length, comments: report.reduce((s,r)=>s+r.comments,0), tokenParity: true}));
