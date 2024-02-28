/*  totp.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const {Gio, GLib} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Base32 = Me ? Me.imports.base32 : imports.base32;

const _ = ExtensionUtils.gettext;


var Algorithm = {

    SHA1: GLib.ChecksumType.SHA1,
    SHA256: GLib.ChecksumType.SHA256,
    SHA512: GLib.ChecksumType.SHA512,


    fromString(arg)
    {
        switch (arg.toUpperCase()) {
        case 'SHA1':
        case 'SHA-1':
            return Algorithm.SHA1;
        case 'SHA256':
        case 'SHA-256':
            return Algorithm.SHA256;
        case 'SHA512':
        case 'SHA-512':
            return Algorithm.SHA512;
        default:
            throw new Error(_('Invalid algorithm:') + ` "${arg}"`);
        }
    },


    toString(arg)
    {
        switch (arg) {
        case Algorithm.SHA1:
            return 'SHA1';
        case Algorithm.SHA256:
            return 'SHA256';
        case Algorithm.SHA512:
            return 'SHA512';
        default:
            if (typeof arg == 'string')
                return arg;
            throw new Error(_('Invalid algorithm:') + ` "${arg}"`);
        }
    }

};


function now()
{
    return new Date().getTime() / 1000;
}


function hex_to_bytes(hex)
{
    let blob = [];
    for (let i = 0; i < hex.length; i += 2)
        blob.push(parseInt(hex.substring(i, i + 2), 16));
    return new Uint8Array(blob);
}


function bytes_to_hex(blob)
{
    let hex = "";
    blob.forEach(x => hex += x.toString(16).padStart(2, '0'));
    return hex;
}


var TOTP = class {

    constructor({
        issuer = '',
        name = '',
        secret = '',
        digits = 6,
        period = 30,
        algorithm = Algorithm.SHA1,
        uri = null
    })
    {
        if (uri) {

        } else {
            this.issuer = issuer;
            this.name = name;
            this.secret = secret;
            this.secret_bin = Base32.decode(secret);
            this.digits = digits;
            this.period = period;
            if (typeof algorithm == 'string')
                algorithm = Algorithm.fromString(algorithm);
            this.algorithm = algorithm;
        }
    }


    wipe()
    {
        for (let i = 0; i < this.secret.length; ++i)
            if (this.secret[i] != '=')
                this.secret[i] = 'A';

        for (let i = 0; i < this.secret_bin.length; ++i)
            this.secret_bin[i] = 0;
    }


    code(time = now())
    {
        let bytes = this.secret_bin;
        let counter = Math.floor(time / this.period);
        let t_hex = `${counter.toString(16)}`.padStart(16, '0');
        let t_bytes = hex_to_bytes(t_hex);

        let hmac_hex = GLib.compute_hmac_for_bytes(this.algorithm,
                                                   this.secret_bin,
                                                   t_bytes);
        let hmac = hex_to_bytes(hmac_hex);

        // extract offset from the lower nibble of the last byte
        let offset = hmac.at(-1) & 0xf;

        // load the big endian uint32 starting at offset, discard top bit
        let view = new DataView(hmac.buffer);

        let value = (view.getUint32(offset) & 0x7fffffff).toString();

        // take the last digits characters of the decimal representation, pad with zeros
        let code = value.slice(-this.digits);

        this.wipe();

        return code.padStart(this.digits, '0');
    }


    uri()
    {
        // See https://github.com/google/google-authenticator/wiki/Key-Uri-Format

        let query = `secret=${this.secret}`;
        this.wipe();

        if (this.issuer != '')
            query = query + `&issuer=${this.issuer}`;

        if (this.digits != 6)
            query = query + `&digits=${this.digits}`;

        if (this.period != 30)
            query = query + `&period=${this.period}`;

        if (this.algorithm != Algorithm.SHA1)
            query = query + `&algorithm=${Algorithm.toString(this.algorithm)}`;

        return GLib.Uri.join(GLib.UriFlags.NONE,
                             'otpauth',
                             null, // no user
                             'totp', // host
                             -1, // port
                             '/' + this.name, // path
                             query,
                             null);
    }

};
