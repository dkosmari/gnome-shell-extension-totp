#!/bin/bash -xe

REF_POT='po/totp@dkosmari.github.com.pot'

xgettext \
     --from-code=UTF-8 \
     --copyright-holder='Daniel K. O.' \
     --package-name='TOTP' \
     --msgid-bugs='https://github.com/dkosmari/gnome-shell-extension-totp' \
     --output="$REF_POT" \
     src/*.js \
     *.js


for f in po/*.po
do
    msgmerge --update "$f" "$REF_POT"
done

exit 0
