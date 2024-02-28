TOTP
====

This is a gnome-shell extension to generate TOTP (Time-based OTP) authentication codes
(such as the ones used by Google, Facebook, Github, etc).


Security
--------

The OTP secret is stored in the GNOME Keyring, in a separate collection called "OTP". For
improved security, users can lock this collection with its own password.

During normal usage, the extension will load the specific OTP secret (unlocking the
Keyring if necessary), copy the authentication code to the clipboard, and immediately wipe
the OTP secret from memory.


Installing from sources
-----------------------

To create an installable .zip file, run the script `./bundle.sh`. It can be installed by
running the `./install.sh` script.


Exporting QR code
-----------------

It's possible to export the OTP secret as a QR code to be scanned into other devices, if
you have the [qrencode](https://fukuchi.org/works/qrencode/) package installed.


Translations
------------

If you want to help with translating, use a PO editor such as [Poedit](https://poedit.net)
or [GNOME Translation Editor](https://wiki.gnome.org/Apps/Gtranslator/) to generate/update
a translation file in the `po` directory.

For new language translations, please submit a pull request; for small corrections or
additions, it's okay to submit a bug report.

