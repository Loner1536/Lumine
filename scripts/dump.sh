#!/bin/bash
# dump-src.sh
OUT="src-dump.md"
>"$OUT"
find package/src -name "*.ts" | sort | while read f; do
    echo "### $f" >>"$OUT"
    echo '```ts' >>"$OUT"
    cat "$f" >>"$OUT"
    echo '```' >>"$OUT"
    echo "" >>"$OUT"
done
echo "Dumped to $OUT"
