/*  otp.js
 * Copyright (C) 2025  Daniel K. O.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const GLib = imports.gi.GLib;

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
        case 'SHA384':
        case 'SHA-384':
            return GLib.ChecksumType.SHA384;
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
        case GLib.ChecksumType.SHA384:
            return 'SHA-384';
        case GLib.ChecksumType.SHA512:
            return 'SHA-512';
        default:
            if (typeof arg == 'string')
                return arg;
            throw new Error(_('Invalid algorithm.'));
        }
    }

}; // class Algorithm


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


function parseURI(uri)
{
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
    if (port != -1)
        throw new Error(_('Unexpected port number in URI.'));

    let result = splitQuery(query);

    result.host = host;
    result.name = path.substring(1);
    result.digits = parseInt(result.digits);
    result.period = parseInt(result.period);
    result.algorithm = Algorithm.str(Algorithm.parse(result.algorithm));

    return result;
}


var OTP =
class OTP {

    // Make sure algorithm is valid.
    set_algorithm(algo)
    {
        this.algorithm = Algorithm.str(Algorithm.parse(algo));
    }


    // destroy this.secret by filling it with zeros
    wipe_secret()
    {
        this.secret = this.secret.replaceAll(/[^=]/g, 'A');
    }


    code(counter)
    {
        const secret_bytes = Base32.decode(this.secret, false);
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
        this.wipe_secret();

        return code.padStart(this.digits, '0');
    }


    uri(args)
    {
        // See https://github.com/google/google-authenticator/wiki/Key-Uri-Format

        let query = `secret=${this.secret}`;
        this.wipe_secret();

        if (this.issuer != '')
            query += `&issuer=${this.issuer}`;

        if (this.digits != 6)
            query += `&digits=${this.digits}`;

        for (const [key, val] of Object.entries(args))
            query += `&${key}=${val}`;

        if (this.algorithm != 'SHA-1') {
            // remove the '-' from the algorithm name
            const algo_str = this.algorithm.replaceAll(/-/g, '');
            query += `&algorithm=${algo_str}`;
        }

        return GLib.Uri.join(GLib.UriFlags.NON_DNS,
                             'otpauth',
                             null, // no user
                             this.type.toLowerCase(), // host
                             -1, // port
                             '/' + this.name, // path
                             query,
                             null);
    }


    fields()
    {
        const result = this.fields_non_destructive();
        this.wipe_secret();
        return result;
    }


    // return all members as strings, as required by libsecret
    fields_non_destructive()
    {
        return {
            type: this.type,
            issuer: this.issuer,
            name: this.name,
            secret: this.secret,
            digits: this.digits.toString(),
            algorithm: this.algorithm
        };
    }

}; // class OTP
