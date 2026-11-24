# TOTP

This is a GNOME Shell extension to generate TOTP (Time-based OTP) and HOTP (counter-based
OTP) authentication codes (such as the ones used by Google, Facebook, Github, Steam, etc).

![screenshot](screenshot.png)


## Security

The OTP secret is stored in the [GNOME
Keyring](https://wiki.gnome.org/Projects/GnomeKeyring), in a separate collection called
"OTP". For improved security, users can lock this collection with its own password.

During normal usage, the extension will load the specific OTP secret (unlocking the
Keyring if necessary), copy the authentication code to the clipboard, and immediately wipe
the OTP secret from memory.

In the preferences window, sensitive data (the `otpauth://` URIs) are automatically
erased from the clipboard after a few seconds (30 by default).


## Installing from GNOME Shell Extensions website

The extension can be obtained from the [GNOME Shell Extensions
website](https://extensions.gnome.org/extension/6793/totp/).


## Installing from sources

Prerequisites:

  - [make](https://www.gnu.org/software/make/)

  - [jq](https://stedolan.github.io/jq/)

  - glib2-devel (Fedora) or glib2.0-common (Mageia) or libgio-2.0-dev-bin (Ubuntu):
    whatever is the package that provides the `glib-compile-resources` tool.

Run:

    make install


## Importing and exporting URIs

It's possible to import and export OTP secrets that conform to [Google's Key URI
Format](https://github.com/google/google-authenticator/wiki/Key-Uri-Format). This format
is compatible with applications like Google Authenticator, FreeOTP, Authy, etc.


## Scanning QR codes

It's possible to scan QR codes from a camera and from the clipboard, if you have the
[ZBar](https://zbar.sourceforge.net/) package installed. In some distros (like Debian and
Ubuntu) the package is named `zbar-tools`.


## Exporting QR code

It's possible to export the OTP secret as a QR code to be scanned into other devices, if
you have the [qrencode](https://fukuchi.org/works/qrencode/) package installed.


## Importing Steam Guard secret

You can generate Steam Guard Mobile Authenticator codes, by importing the "shared secret"
from your Android phone.

See the [Steam Guard](steam.md) document for more details.


## Yandex OTP (YAOTP)

This fork also supports the proprietary Yandex OTP scheme used by [Yandex ID](https://id.yandex.ru)
(formerly Yandex.Key), both for Yandex accounts and for third-party TOTP entries stored in
that app.

Yandex's scheme is not RFC 6238: the code consists of lowercase letters (`a`..`z`), the key
is `SHA-256(pin || secret)`, and the HMAC-SHA-256 output is truncated to 64 bits. A PIN is
mandatory — Yandex never exports it, so it must be typed in the preferences window. The
extension keeps it as an additional keyring attribute of that entry.

To import, use the `otpauth://yaotp/...` URIs from a Yandex ID export
("Export to file" in the app's settings). The exported `pin_length` parameter is honoured,
and a wrong-length or missing PIN is reported instead of producing a wrong code.

Secret lengths accepted: 16 bytes (from a QR code, PIN length must be given), 18 bytes
(the short form found in file exports) and 26 bytes and longer (key + user id + PIN length
and a 13-bit checksum, which is verified).

The algorithm follows the reference implementations in
[KeeYaOtp](https://github.com/norblik/KeeYaOtp),
[libcotp](https://github.com/paolostivanin/libcotp) and
[Aegis](https://github.com/beemdevelopment/Aegis), and is checked against the published
Aegis test vectors (`tests/yaotp_test.js`, run with `gjs -m tests/yaotp_test.js`).


## Related extensions

When using this extension on a laptop, it's a good idea to also install [Keyring
Autolock](https://extensions.gnome.org/extension/6846/keyring-autolock/). It will ensure
your Keyring gets locked after a period of time, so you never forget to keep your OTP
secrets protected.
