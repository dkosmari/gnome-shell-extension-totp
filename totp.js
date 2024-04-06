/*  totp.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const {GLib} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Base32 = Me.imports.base32;


// strings will be translated by gettext in the frontend
const _ = x => x;


class Algorithm {

    static parse(arg)
    {
        if (typeof arg != 'string')
            return arg;

        switch (arg.toUpperCase()) {
        case 'SHA1':
        case 'SHA-1':
            return GLib.ChecksumType.SHA1;
        case 'SHA256':
        case 'SHA-256':
            return GLib.ChecksumType.SHA256;
        case 'SHA512':
        case 'SHA-512':
            return GLib.ChecksumType.SHA512;
        default:
            throw new Error(_('Invalid algorithm.'));
        }
    }


    static str(arg)
    {
        switch (arg) {
        case GLib.ChecksumType.SHA1:
            return 'SHA-1';
        case GLib.ChecksumType.SHA256:
            return 'SHA-256';
        case GLib.ChecksumType.SHA512:
            return 'SHA-512';
        default:
            if (typeof arg == 'string')
                return arg;
            throw new Error(_('Invalid algorithm.'));
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


function splitQuery(query)
{
    let entries = query.split('&');
    let result = {};
    entries.forEach(x => {
        let re = /(?<key>[^=]+)=(?<value>.*)/;
        let found = x.match(re);
        if (found)
            result[found.groups.key] = found.groups.value;
    });
    return result;
}


var TOTP =
class TOTP {

    constructor({
        issuer = '',
        name = '',
        secret = '',
        digits = 6,
        period = 30,
        algorithm = 'SHA-1',
        uri = null
    } = {})
    {
        if (uri) {
            let [success,
                 scheme,
                 userinfo,
                 host,
                 port,
                 path,
                 query,
                 fragment] = GLib.Uri.split(uri, GLib.UriFlags.NON_DNS);
            if (!success)
                throw new Error(_('Failed to parse URI.'));
            if (scheme != 'otpauth')
                throw new Error(_('URI scheme should be "otpauth://..."'));
            if (host != 'totp')
                throw new Error(_('URI host should be "totp"'));
            if (port != -1)
                throw new Error(_('Unexpected port number in URI.'));

            /*
            if (userinfo)
                console.warn(_('Unexpected userinfo in URI.'));
            if (fragment)
                console.warn(`Unexpected fragment in URI: ${fragment}`);
            */

            let {
                issuer = '',
                secret = '',
                digits = 6,
                period = 30,
                algorithm = 'SHA-1'
            } = splitQuery(query);

            this.issuer = issuer;
            this.name = path.substring(1);
            this.secret = secret;
            this.digits = parseInt(digits);
            this.period = parseInt(period);
            this.algorithm = Algorithm.str(Algorithm.parse(algorithm));
        } else {
            this.issuer = issuer;
            this.name = name;
            this.secret = secret;
            this.digits = parseInt(digits);
            this.period = parseInt(period);
            this.algorithm = Algorithm.str(Algorithm.parse(algorithm));
        }
    }


    wipe()
    {
        this.secret = this.secret.replaceAll(/[^=]/g, 'A');
    }


    code(time = now())
    {
        const secret_bytes = Base32.decode(this.secret, false);
        const counter = Math.trunc(time / this.period);
        const counter_hex = `${counter.toString(16)}`.padStart(16, '0');
        const counter_bytes = hex_to_bytes(counter_hex);
        const algorithm = Algorithm.parse(this.algorithm);

        const hmac_hex = GLib.compute_hmac_for_bytes(algorithm,
                                                     secret_bytes,
                                                     counter_bytes);
        const hmac = hex_to_bytes(hmac_hex);

        // extract offset from the lower nibble of the last byte
        const offset = hmac.at(-1) & 0xf;

        // load the big endian uint32 starting at offset, discard top bit
        const view = new DataView(hmac.buffer);
        let value = view.getUint32(offset) & 0x7fffffff;
        let value_str = '';

        if (this.issuer.toUpperCase() == 'STEAM') {
            // Steam OTP uses this reversed base-26 encoding.
            const steam_digits = "23456789BCDFGHJKMNPQRTVWXY";
            for (let i = 0; i < this.digits; ++i) {
                value_str += steam_digits[value % 26];
                value = Math.trunc(value / 26);
            }
        } else {
            // regular OTP uses decimal
            value_str = value.toString();
        }

        // take the last 'digits' characters of the string representation, pad with zeros
        let code = value_str.slice(-this.digits);
        this.wipe();

        return code.padStart(this.digits, '0');
    }


    // return code and expiry
    code_and_expiry()
    {
        const t = now();
        const code = this.code(t);
        const expiry = (Math.trunc(t / this.period) + 1) * this.period;
        return [code, expiry];
    }


    uri()
    {
        // See https://github.com/google/google-authenticator/wiki/Key-Uri-Format

        let query = `secret=${this.secret}`;
        this.wipe();

        if (this.issuer != '')
            query += `&issuer=${this.issuer}`;

        if (this.digits != 6)
            query += `&digits=${this.digits}`;

        if (this.period != 30)
            query = query + `&period=${this.period}`;

        if (this.algorithm != 'SHA-1') {
            // remove the '-' from the algorithm name
            const algo_str = this.algorithm.replaceAll(/-/g, '');
            query += `&algorithm=${algo_str}`;
        }

        return GLib.Uri.join(GLib.UriFlags.NON_DNS,
                             'otpauth',
                             null, // no user
                             'totp', // host
                             -1, // port
                             '/' + this.name, // path
                             query,
                             null);
    }


    fields()
    {
        const result = this.fields_non_destructive();
        this.wipe();
        return result;
    }


    // return all members as strings, as required by libsecret
    fields_non_destructive()
    {
        return {
            issuer: this.issuer,
            name: this.name,
            secret: this.secret,
            digits: this.digits.toString(),
            period: this.period.toString(),
            algorithm: this.algorithm
        };
    }

};
