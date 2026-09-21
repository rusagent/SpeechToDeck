import ast
import io
import json
import re
import subprocess
import sys
import tokenize
from pathlib import Path

import yaml

ROOT = Path.cwd()
FILES = subprocess.check_output(['git', 'ls-files', '-z'], text=True).split('\0')[:-1]
REPORT = []


def replace_once(text, before, after, count=1):
    if text.count(before) != count:
        raise ValueError(f'Expected {count} occurrences of {before!r}; found {text.count(before)}')
    return text.replace(before, after)


def erase(text, spans):
    result = text
    for start, end, replacement in sorted(spans, reverse=True):
        original = result[start:end]
        if replacement:
            padding = re.sub(r'[^\r\n]', ' ', original[len(replacement):])
            result = result[:start] + replacement + padding + result[end:]
        else:
            result = result[:start] + re.sub(r'[^\r\n]', ' ', original) + result[end:]
    old_lines = text.split('\n')
    return '\n'.join(
        line.rstrip() if line != old_lines[i] else line
        for i, line in enumerate(result.split('\n'))
        if not (line.strip() == '' and old_lines[i].strip() != '')
    ).lstrip('\n')


def python_spans(text):
    lines = text.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))

    def point(line, column):
        return offsets[line - 1] + column

    def ast_point(line, column):
        prefix = lines[line - 1].encode('utf-8')[:column].decode('utf-8')
        return point(line, len(prefix))

    comments = []
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type == tokenize.COMMENT and not (token.start == (1, 0) and token.string.startswith('#!')):
            comments.append((point(*token.start), point(*token.end), ''))
    docs = []
    tree = ast.parse(text)
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not node.body:
            continue
        first = node.body[0]
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
            replacement = 'pass' if len(node.body) == 1 and not isinstance(node, ast.Module) else ''
            docs.append((ast_point(first.lineno, first.col_offset), ast_point(first.end_lineno, first.end_col_offset), replacement))
    return comments, docs


class WithoutDocumentation(ast.NodeTransformer):
    def visit(self, node):
        node = super().visit(node)
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant) and isinstance(node.body[0].value.value, str):
                node.body = node.body[1:]
            if not node.body and not isinstance(node, ast.Module):
                node.body = [ast.Pass()]
        return node


def python_signature(text):
    return ast.dump(WithoutDocumentation().visit(ast.parse(text)), include_attributes=False)


def hash_comments(text, shell=False):
    spans = []
    offset = 0
    heredoc = None
    multiline_quote = None
    for line in text.splitlines(keepends=True):
        if heredoc:
            if line.strip() == heredoc:
                heredoc = None
            offset += len(line)
            continue
        if shell:
            match = re.search(r'<<-?\s*[\'\"]?([A-Za-z_][A-Za-z_0-9]*)[\'\"]?', line)
            if match:
                heredoc = match.group(1)
        quote = multiline_quote
        i = 0
        while i < len(line):
            char = line[i]
            if quote:
                if char == '\\' and quote != "'":
                    i += 2
                    continue
                if line.startswith(quote, i):
                    i += len(quote)
                    quote = None
                    continue
            elif line.startswith('"""', i) or line.startswith("'''", i):
                quote = line[i:i+3]
                i += 3
                continue
            elif char in "\"'":
                quote = char
            elif char == '\\':
                i += 2
                continue
            elif char == '#' and (not shell or i == 0 or line[i-1].isspace()):
                if not (offset == 0 and i == 0 and line.startswith('#!')):
                    spans.append((offset + i, offset + len(line.rstrip('\r\n')), ''))
                break
            i += 1
        multiline_quote = quote
        offset += len(line)
    return erase(text, spans), len(spans)


def yaml_cleanup(text):
    protected = []
    block_tokens = []
    for token in yaml.scan(text):
        if isinstance(token, yaml.tokens.ScalarToken):
            protected.append((token.start_mark.index, token.end_mark.index))
            if token.style in ('|', '>'):
                block_tokens.append(token)
    spans = []
    for match in re.finditer(r'#[^\r\n]*', text):
        start = match.start()
        if not any(a <= start < b for a, b in protected):
            spans.append((start, match.end(), ''))
    for token in block_tokens:
        block = text[token.start_mark.index:token.end_mark.index]
        cleaned, count = hash_comments(block, shell=True)
        if count:
            old_lines = block.splitlines(keepends=True)
            new_lines = cleaned.splitlines(keepends=True)
            import difflib
            matcher = difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False)
            offsets = [0]
            for line in old_lines:
                offsets.append(offsets[-1] + len(line))
            for tag, i, j, k, l in matcher.get_opcodes():
                if tag == 'delete':
                    spans.append((token.start_mark.index + offsets[i], token.start_mark.index + offsets[j], ''))
                elif tag != 'equal':
                    raise ValueError('Unexpected non-line shell comment in workflow')
    return erase(text, spans), len(spans)


def markdown_cleanup(text):
    hidden = list(re.finditer(r'<!--[\s\S]*?-->', text))
    result = erase(text, [(m.start(), m.end(), '') for m in hidden])
    count = len(hidden)
    pattern = r'(^[ \t]*```(bash|sh|shell|toml|yaml|yml|python|py)[ \t]*\n)([\s\S]*?)(^[ \t]*```[ \t]*$)'
    def clean_fence(match):
        nonlocal count
        language = match.group(2)
        body = match.group(3)
        if language in ('bash', 'sh', 'shell', 'toml'):
            clean, found = hash_comments(body, shell=language != 'toml')
        elif language in ('yaml', 'yml'):
            clean, found = yaml_cleanup(body)
        else:
            comments, docs = python_spans(body)
            clean, found = erase(body, comments + docs), len(comments) + len(docs)
        count += found
        return match.group(1) + clean + match.group(4)
    result = re.sub(pattern, clean_fence, result, flags=re.MULTILINE)
    return result, count


for filename in FILES:
    path = ROOT / filename
    try:
        original = path.read_text(encoding='utf-8')
    except UnicodeDecodeError:
        REPORT.append({'path': filename, 'binary': True, 'changed': False})
        continue
    changed = original
    count = 0
    docs_count = 0
    if path.suffix == '.py':
        comments, docs = python_spans(original)
        changed = erase(original, comments + docs)
        count, docs_count = len(comments), len(docs)
        if python_signature(original) != python_signature(changed):
            raise ValueError(f'{filename}: Python syntax tree changed')
    elif path.suffix in ('.yml', '.yaml'):
        changed, count = yaml_cleanup(original)
    elif path.suffix == '.toml' or path.name in ('.gitignore', '.prettierignore', '.npmrc'):
        changed, count = hash_comments(original)
    elif path.suffix == '.md' or path.name == 'defaults.txt':
        changed, count = markdown_cleanup(original)
    elif path.suffix == '.html':
        spans = [(m.start(), m.end(), '') for m in re.finditer(r'<!--[\s\S]*?-->', original)]
        changed, count = erase(original, spans), len(spans)
    if changed != original:
        path.write_text(changed, encoding='utf-8')
    REPORT.append({'path': filename, 'comments': count, 'docstrings': docs_count, 'changed': changed != original})

path = ROOT / 'tests/backend/conftest.py'
text = path.read_text()
text = replace_once(text, '            "# The real surface is [binary, --config CFG, daemon]: the global\\n"\n            "# --config precedes the subcommand, so match on membership.\\n"\n', '')
text = replace_once(text, '        model_path_for = lambda model_id: paths.models_dir / f"ggml-{model_id}.bin"', '        def model_path_for(model_id: str) -> Path:\n            return paths.models_dir / f"ggml-{model_id}.bin"')
path.write_text(text)

path = ROOT / 'tests/backend/test_daemon_supervisor.py'
text = path.read_text()
for before, after in [
    ('    async def probe(resolver, config_path):  # auto-policy stand-in, deterministic\\n', '    async def probe(resolver, config_path):\\n'),
    ('        return False  # cpu\\n', '        return False\\n'),
    ('    await asyncio.Event().wait()  # held until the test SIGKILLs us\\n', '    await asyncio.Event().wait()\\n'),
    ('"# store update v2\\n"', '"\\n"'),
]:
    text = replace_once(text, before, after)
path.write_text(text)

path = ROOT / 'backend/infrastructure/settings/json_settings_repository.py'
text = path.read_text()
text = replace_once(text, 'from pathlib import Path\n', 'from pathlib import Path\nfrom typing import cast\n')
text = replace_once(text, 'from backend.domain.contracts import Settings', 'from backend.domain.contracts import ComputeBackend, Settings')
text = replace_once(text, 'compute_backend=compute_backend,', 'compute_backend=cast(ComputeBackend, compute_backend),')
path.write_text(text)

path = ROOT / 'backend/infrastructure/process/daemon_supervisor.py'
text = path.read_text()
text = replace_once(text, 'from pathlib import Path\n', 'from pathlib import Path\nfrom types import ModuleType\n')
text = replace_once(text, '    import ctypes\n', '    import ctypes as _ctypes\n\n    ctypes: ModuleType | None = _ctypes\n')
text = replace_once(text, '    if ctypes is None or not sys.platform.startswith("linux"):', '    ctypes_module = ctypes\n    if ctypes_module is None or not sys.platform.startswith("linux"):')
text = replace_once(text, 'ctypes.CDLL(', 'ctypes_module.CDLL(')
text = replace_once(text, 'ctypes.get_errno()', 'ctypes_module.get_errno()')
path.write_text(text)

path = ROOT / 'tests/contract/SteamClipboardAdapter.test.ts'
text = path.read_text()
text = replace_once(text, 'delete navigator.clipboard;', 'delete (navigator as { clipboard?: Clipboard }).clipboard;', 2)
path.write_text(text)

path = ROOT / 'pyproject.toml'
text = path.read_text()
text += '\n[tool.ruff.lint.per-file-ignores]\n"main.py" = ["E402"]\n"tests/backend/conftest.py" = ["E402"]\n\n[[tool.mypy.overrides]]\nmodule = ["decky_plugin", "helpers"]\nignore_missing_imports = true\n'
path.write_text(text)

path = ROOT / 'tests/visual/decky-ui-standin.js'
text = path.read_text()
spans = [(m.start(), m.end(), '') for m in re.finditer(r'/\*[\s\S]*?\*/', text)]
if len(spans) != 3:
    raise ValueError(f'Expected three embedded CSS comments, got {len(spans)}')
path.write_text(erase(text, spans))

report_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/comment-cleanup-python.json')
report_path.write_text(json.dumps(REPORT, indent=2) + '\n')
print(json.dumps({'files': len(FILES), 'comments': sum(row.get('comments', 0) for row in REPORT), 'docstrings': sum(row.get('docstrings', 0) for row in REPORT)}))
