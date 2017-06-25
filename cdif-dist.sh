#!/bin/sh
basedir=`dirname "$0"`
path=`readlink -f "$0"`
basepath=`dirname $path`

which bunyan
OUT=$?

if [ $OUT -eq 0 ];then
  NODE_PATH=$basepath/../lib node --expose-gc "$basepath/app.js" "$@" | bunyan
else
  NODE_PATH=$basepath/../lib node --expose-gc "$basepath/app.js" "$@"
fi
