#!/bin/bash -x

exec gnome-extensions pack \
     --force \
     --podir=po \
     --extra-source=AUTHORS \
     --extra-source=COPYING \
     --extra-source=README.md \
     --extra-source={src,icons} \
     .
