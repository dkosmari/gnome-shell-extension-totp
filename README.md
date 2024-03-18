TOTP
====

This is a gnome-shell extension to generate TOTP (Time-based OTP) authentication codes
(such as the ones used by Google, Facebook, Github, Steam, etc).


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


Importing Steam Guard secret
----------------------------

You can generate Steam Guard Mobile Authenticator codes.

  1. Search the web for instructions on how to extract your Steam Guard
     `shared_secret`. The method may vary depending on factors like your Android version,
     rooted status, Steam Mobile version, etc.

  2. The `shared_secret` is encoded in `Base64`, not `Base32`; so when you import it,
     select `base64`. The secret will still be stored in the keyring in `base32` encoding,
     so don't be alarmed that it "changed."

  3. Set `Digits = 5`. Everything else is the default: `Period = 30`, `Algorithm = SHA-1`.

  4. The issuer must be `Steam`, to activate the special OTP encoding that Steam Guard
     uses. Otherwise it will generate plain decimal code.


Sorting secrets
---------------

Secrets are sorted alphabetically by their keyring label. When an OTP secret is created or
edited, its label is set to the string `Issuer:Name`. There is currently no mechanism in
the extension to set the label, it will always be reset to `Issuer:Name` when you edit the
secret. The label is not shown in the user interface, and does not affect any other
functionality, other than sorting.

Using a tool like [Seahorse](https://wiki.gnome.org/Apps/Seahorse) it's possible manually
edit the labels (Seahorse calls them "Description") in your OTP collection. You can add
numbers in front of the label, to affect their ordering. For instance:

   - `00 Google:myname`

   - `01 Yahoo:myothername`

   - `02 Facebook:yetanothername`
