#!/usr/bin/env python3
from pathlib import Path
import os
import re
import sys


def update_formula(text: str, *, version: str, tag: str, asset_name: str, sha256: str) -> str:
    url = f"https://github.com/Yaphet2015/ya-skills/releases/download/{tag}/{asset_name}"
    text = re.sub(r'url "[^"]+"', f'url "{url}"', text, count=1)
    text = re.sub(r'(?m)^[ \t]*version "[^"]+"\n', "", text, count=1)
    text = re.sub(r'sha256 "[^"]+"', f'sha256 "{sha256}"', text, count=1)
    text = re.sub(
        r'assert_match "[^"]+", shell_output\("\#\{bin\}/yk --version"\)',
        f'assert_match "{version}", shell_output("#{{bin}}/yk --version")',
        text,
        count=1,
    )
    return text


def main() -> None:
    formula = Path(sys.argv[1])
    formula.write_text(
        update_formula(
            formula.read_text(),
            version=os.environ["VERSION"],
            tag=os.environ["TAG_NAME"],
            asset_name=os.environ["ASSET_NAME"],
            sha256=os.environ["ASSET_SHA256"],
        )
    )


if __name__ == "__main__":
    main()
