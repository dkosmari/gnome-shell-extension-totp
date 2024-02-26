#!/bin/bash -x

exec xgettext \
     --from-code=UTF-8 \
     --copyright-holder='Daniel K. O.' \
     --package-name='TOTP' \
     --msgid-bugs='https://github.com/dkosmari/gnome-shell-extension-totp' \
     --output=po/totp@dkosmari.github.com.pot \
     *.js
