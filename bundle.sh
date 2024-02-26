#!/bin/bash -x

exec gnome-extensions pack --force --podir=po \
     --extra-source=COPYING \
     --extra-source={base32,indicator,secretUtils,totp}.js \
     .
