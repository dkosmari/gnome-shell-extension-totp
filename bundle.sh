#!/bin/bash -x

exec gnome-extensions pack \
     --force \
     --podir=po \
     --extra-source=COPYING \
     --extra-source=AUTHORS \
     --extra-source={src,icons} \
     .
