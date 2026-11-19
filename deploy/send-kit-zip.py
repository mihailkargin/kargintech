#!/usr/bin/env python3
"""Запасная передача комплекта без локального tar: ZIP + SSH + Python на сервере."""
import argparse
import os
from pathlib import Path, PurePosixPath
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
EXCLUDED_NAMES = {'.env', '__pycache__'}


def files_for(parts):
    files = []
    for part in parts:
        source = ROOT / part
        if not source.exists():
            raise SystemExit(f'Нет {part} в папке проекта')
        candidates = [source] if source.is_file() else (p for p in source.rglob('*') if p.is_file())
        for file in candidates:
            relative = file.relative_to(ROOT)
            posix = PurePosixPath(relative.as_posix())
            if any(name in EXCLUDED_NAMES or name.startswith('.env.bak') for name in posix.parts):
                continue
            if file.suffix == '.pyc':
                continue
            files.append((file, posix))
    return sorted(files, key=lambda item: str(item[1]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('server')
    parser.add_argument('--abroad', action='store_true')
    args = parser.parse_args()
    parts = ['deploy/abroad', 'deploy/backup-offsite-receive.sh'] if args.abroad else [
        'src', 'app', 'site', 'deploy', 'n8n', 'package.json'
    ]
    files = files_for(parts)
    import io
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        for file, relative in files:
            archive.write(file, str(relative))
    payload = stream.getvalue()
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = archive.namelist()
        if len(names) != len(files) or any(name.startswith('/') or '..' in PurePosixPath(name).parts for name in names):
            raise SystemExit('Проверка ZIP не прошла')
    destination = '~/kargintech-abroad' if args.abroad else '~/kargintech'
    remote = (
        'set -e; '
        f'mkdir -p {destination}; '
        'cat > /tmp/kargintech-kit.zip; '
        f'python3 -m zipfile -e /tmp/kargintech-kit.zip {destination}; '
        'rm -f /tmp/kargintech-kit.zip; '
        f'cd {destination}; echo ПРИНЯТО:; find . -type f | wc -l'
    )
    windows_ssh = Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32/OpenSSH/ssh.exe'
    ssh = str(windows_ssh) if os.name == 'nt' and windows_ssh.exists() else 'ssh'
    result = subprocess.run(
        [ssh, '-o', 'BatchMode=yes', args.server, remote],
        input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300
    )
    print(result.stdout.decode('utf-8', errors='replace'), end='')
    if result.returncode:
        print(result.stderr.decode('utf-8', errors='replace'))
        raise SystemExit(result.returncode)
    print(f'Отправлено файлов: {len(files)}. Число после «ПРИНЯТО:» должно быть не меньше.')


if __name__ == '__main__':
    main()
