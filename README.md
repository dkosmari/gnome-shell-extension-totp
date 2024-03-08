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


Installing from GNOME Shell Extensions website
----------------------------------------------

The extension can be obtained from the [GNOME Shell Extensions
website](https://extensions.gnome.org/extension/6793/totp/).


Installing from sources
-----------------------

To create an installable .zip file, run the script `./bundle.sh`. It can be installed by
running the `./install.sh` script.


Importing and exporting URIs
----------------------------

It's possible to import and export OTP secrets that conform to [Google's Key URI
Format](https://github.com/google/google-authenticator/wiki/Key-Uri-Format). This format
is compatible with applications like Google Authenticator, FreeOTP, Authy, etc.


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

