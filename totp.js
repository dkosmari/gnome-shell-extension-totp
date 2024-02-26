/*  totp.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const {Gio, GLib} = imports.gi;

try {
    // check if inside gnome-shell
    imports.misc.extensionUtils;
}
catch (e) {
    // setup an environment that looks like gnome-shell
    const resource =
              Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Extensions.src.gresource');
    resource._register();
    imports.searchPath.push('resource:///org/gnome/Extensions/js');
}

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
        blob.push(parseInt(hex.substr(i, 2), 16));
    return new Uint8Array(blob);
}


function bytes_to_hex(blob)
{
    let hex = "";
    blob.forEach(x => hex += x.toString(16).padStart(2, '0'));
    return hex;
}


// See RFC 4648
function base32_to_bytes(input)
{
    const digits = 'abcdefghijklmnopqrstuvwxyz234567';
    let output = [];

    // process 40 bits at a time (8 base32 digits)
    for (let i = 0; i < input.length; i += 8) {
        let chunk = input.substr(i, 8).padEnd(8, '=');
        let value = 0;
        for (let j = 0; j < 8; ++j) {
            let d = chunk[j].toLowerCase();
            let idx = digits.indexOf(d);

            if (d == '=')
                idx = 0;
            if (idx == -1)
                throw new Error(_('Invalid base32 character at position:')
                                + ` ${i + j}`);

            value = value * 32 + idx;
        }

        // store in little endian
        let value_bytes = [];
        for (let j = 0; j < 5; ++j) {
            value_bytes.push(value % 256);
            value = Math.floor(value / 256);
        }
        // turn to big endian
        value_bytes.reverse();

        output = output.concat(value_bytes);
    }

    return new Uint8Array(output);
}


var TOTP = class {

    constructor({
        issuer = '',
        name,
        secret,
        digits = 6,
        period = 30,
        algorithm = Algorithm.SHA1
    })
    {
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
        let code = (view.getUint32(offset) & 0x7fffffff).toString();

        // take the last digits characters of the decimal representation, pad with zeros
        let otp = code.slice(-this.digits);
        return otp.padStart(this.digits, '0');
    }


    uri()
    {
        // See https://github.com/google/google-authenticator/wiki/Key-Uri-Format
        let query = `secret=${this.secret}`;
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




function _test()
{
    let secret = 'abcdabcd';
    let a = new TOTP({name: 'AA@BB', secret});
    log(`a.code = ${a.code()}`);
    log('URI: ', a.uri());
}


// if (!Me)
//     _test();
