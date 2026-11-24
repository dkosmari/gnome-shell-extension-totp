/*  yaotp.js
 * Copyright (C) 2025  Daniel K. O.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Yandex OTP ("YAOTP"), used by Yandex ID (formerly Yandex.Key).
 *
 * This is NOT RFC 6238: the code is 8 lowercase letters (base-26), the key is
 * `SHA-256(pin || secret)` and the HMAC-SHA-256 output is truncated to 64 bits
 * instead of the 31 bits of RFC 4226. The algorithm matches the reference
 * implementations in KeeYaOtp (C#), libcotp (C) and Aegis (Java).
 *
 * Secret formats (decoded from base32):
 *
 *   16 bytes          key only (from a QR code); the PIN length must be given.
 *   26 bytes          key(16) + user id(8) + pin length nibble and CRC-13(2).
 *   18 bytes          key(16) + pin length nibble and CRC-13(2) -- seen in the
 *                     file export of the Yandex ID app.
 *
 * Test vector (from Aegis' YAOTPTest):
 *   pin = "7586", secret = "LA2V6KMCGYMWWVEW64RNP3JA3IAAAAAAHTSG4HRZPI",
 *   time = 1581064020, digits = 8  =>  code = "oactmacq"
 */

import GLib from 'gi://GLib';

import * as Base32 from './base32.js';
import * as OTP from './otp.js';


// strings will be translated by gettext in the frontend
const _ = x => x;


const KEY_BYTES       = 16;
const FULL_SECRET     = 26;    // key + user id + pin length + checksum
const CHECKSUM_BYTES  = 2;
const DEFAULT_DIGITS  = 8;
const DEFAULT_PERIOD  = 30;
const DEFAULT_ISSUER  = 'Yandex';
const DEFAULT_PIN_MIN = 4;
const DEFAULT_PIN_MAX = 16;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

// 13-bit CRC polynomial used by Yandex
const CRC_POLY = 0x18f3;


function hex_to_bytes(hex)
{
    let blob = [];
    for (let i = 0; i < hex.length; i += 2)
        blob.push(parseInt(hex.substring(i, i + 2), 16));
    return new Uint8Array(blob);
}


// Number of leading zero bits in a 16-bit value.
function clz16(value)
{
    if (value == 0)
        return 16;
    let n = 0;
    if ((value & 0xff00) == 0) { n += 8; value = (value << 8) & 0xffff; }
    if ((value & 0xf000) == 0) { n += 4; value = (value << 4) & 0xffff; }
    if ((value & 0xc000) == 0) { n += 2; value = (value << 2) & 0xffff; }
    if ((value & 0x8000) == 0) { n += 1; }
    return n;
}


// Port of KeeYaOtp's Secret.ChecksumIsValid(). The stored 12-bit checksum lives
// in the lower nibble of the second-to-last byte plus the last byte; every other
// bit is fed MSB first into a 13-bit accumulator with the polynomial.
function checksum_is_valid(bytes)
{
    const len = bytes.length;
    if (len < 4)
        return false;

    const stored = ((bytes[len - 2] & 0x0f) << 8) | bytes[len - 1];

    let accum = 0;
    let accum_bits = 0;
    let total_bits = len * 8 - 12;
    let idx = 0;
    let bits_left = 8;

    while (total_bits > 0) {
        let required = 13 - accum_bits;
        if (total_bits < required)
            required = total_bits;

        while (required > 0) {
            let cur = bytes[idx] & ((1 << bits_left) - 1);
            const to_read = required > bits_left ? bits_left : required;
            cur = cur >> (bits_left - to_read);
            accum = ((accum << to_read) | cur) & 0xffff;

            total_bits  -= to_read;
            required    -= to_read;
            bits_left   -= to_read;
            accum_bits  += to_read;

            if (bits_left == 0) {
                ++idx;
                bits_left = 8;
            }
        }

        if (accum_bits == 13)
            accum ^= CRC_POLY;

        accum_bits = 16 - clz16(accum);
    }

    return accum == stored;
}


/*
 * Decode and validate the secret.
 * Returns { key: Uint8Array(16), pin_length: number or 0 if unknown }.
 */
export
function parse_secret(base32_secret)
{
    let bytes;
    try {
        bytes = Base32.decode(base32_secret.replaceAll(/\s/g, ''), false);
    }
    catch (e) {
        throw new Error(_('Invalid Yandex secret.') + ' ' + e.message);
    }

    if (bytes.length < KEY_BYTES)
        throw new Error(_('Invalid Yandex secret: too short.'));

    let key;
    let pin_length = 0;

    if (bytes.length >= FULL_SECRET) {
        // the trailing 26 bytes are: key, user id, pin length + checksum
        const start = bytes.length - FULL_SECRET;
        if (!checksum_is_valid(bytes.subarray(start)))
            throw new Error(_('Invalid Yandex secret: checksum mismatch.'));
        key = bytes.subarray(start, start + KEY_BYTES);
        pin_length = (bytes[bytes.length - 2] >> 4) + 1;
    }
    else if (bytes.length == KEY_BYTES + CHECKSUM_BYTES) {
        // short export variant: key, pin length + checksum
        key = bytes.subarray(0, KEY_BYTES);
        if (checksum_is_valid(bytes))
            pin_length = (bytes[bytes.length - 2] >> 4) + 1;
        // otherwise the trailing bytes are not a checksum block; leave the PIN
        // length to the caller, which may get it from the URI.
    }
    else
        // bare key (from a QR code), no checksum, no PIN length
        key = bytes.subarray(0, KEY_BYTES);

    return { key: key, pin_length: pin_length };
}


function decode_component(text)
{
    try {
        return decodeURIComponent(text.replaceAll('+', ' '));
    }
    catch (e) {
        return text;
    }
}


/*
 * OTP.parseURI() flattens the query and then overwrites the "name" key with the
 * URI path, so a Yandex URI (which has both) needs its own parser.
 */
function parse_yaotp_uri(uri)
{
    const [success, scheme, userinfo, host, port, path, query, fragment] =
          GLib.Uri.split(uri, GLib.UriFlags.NON_DNS);
    if (!success)
        throw new Error(_('Failed to parse URI.'));
    if (scheme != 'otpauth')
        throw new Error(_('URI scheme should be "otpauth://..."'));
    if (port != -1)
        throw new Error(_('Unexpected port number in URI.'));

    const params = {};
    for (const entry of (query || '').split('&')) {
        const at = entry.indexOf('=');
        if (at > 0)
            params[entry.substring(0, at)] = entry.substring(at + 1);
    }

    // GLib.Uri.split() doesn't percent-decode; neither does the caller.
    return {
        host   : host || '',
        path   : path ? path.substring(1) : '',
        params : params
    };
}


export default
class YaOTP extends OTP.OTP {

    constructor({
        issuer = DEFAULT_ISSUER,
        name = '',
        secret = '',
        pin = '',
        digits = DEFAULT_DIGITS,
        period = DEFAULT_PERIOD,
        pin_length = 0,
        uri = null
    } = {})
    {
        super();

        this.type = 'YAOTP';
        this.algorithm = 'SHA-256'; // fixed by the scheme

        if (!uri) {
            this.issuer     = issuer;
            this.name       = name;
            this.secret     = secret;
            this.pin        = pin;
            this.digits     = parseInt(digits) || DEFAULT_DIGITS;
            this.period     = parseInt(period) || DEFAULT_PERIOD;
            this.pin_length = parseInt(pin_length) || 0;
            return;
        }

        const parsed = parse_yaotp_uri(uri);
        if (parsed.host.toLowerCase() != 'yaotp')
            throw new Error(_('URI host should be "yaotp"'));

        const params = parsed.params;

        // Yandex puts the login in the path and the display name in "name".
        const path_name = parsed.path ? decode_component(parsed.path) : '';
        const display_name = params.name ? decode_component(params.name) : '';

        this.issuer = params.issuer ? decode_component(params.issuer) : DEFAULT_ISSUER;
        this.name   = display_name || path_name || 'Yandex';
        this.secret = params.secret || '';

        this.pin        = params.pin ? decode_component(params.pin) : '';
        this.period     = parseInt(params.period) || DEFAULT_PERIOD;
        this.pin_length = parseInt(params.pin_length) || 0;

        // Yandex calls the code length "length"; accept "digits" too.
        this.digits = parseInt(params.length || params.digits) || DEFAULT_DIGITS;

        if (!this.secret)
            throw new Error(_('URI is missing the secret.'));

        // Fail early (and loudly) on a corrupt secret, so the user notices at
        // import time rather than when a code is needed.
        const info = parse_secret(this.secret);
        if (this.pin_length == 0)
            this.pin_length = info.pin_length;
    }


    // The PIN is checked lazily: an imported entry may exist before the user
    // typed its PIN, and only code generation actually needs it.
    check_pin()
    {
        if (!this.pin)
            throw new Error(_('Yandex OTP requires a PIN.'));

        if (!/^\d+$/.test(this.pin))
            throw new Error(_('The PIN must consist of digits.'));

        const min = DEFAULT_PIN_MIN;
        const max = DEFAULT_PIN_MAX;
        if (this.pin.length < min || this.pin.length > max)
            throw new Error(_('Invalid PIN length.') + ` (${min}..${max})`);

        if (this.pin_length && this.pin.length != this.pin_length)
            throw new Error(_('Invalid PIN length.') + ` (${_('expected')} ${this.pin_length})`);
    }


    code(time = new Date().getTime() / 1000)
    {
        this.check_pin();

        const info = parse_secret(this.secret);
        this.wipe_secret();

        if (info.pin_length && info.pin_length != this.pin.length)
            throw new Error(_('Invalid PIN length.') + ` (${_('expected')} ${info.pin_length})`);

        const pin_bytes = new TextEncoder().encode(this.pin);

        // key_hash = SHA-256(pin || key)
        const material = new Uint8Array(pin_bytes.length + info.key.length);
        material.set(pin_bytes, 0);
        material.set(info.key, pin_bytes.length);

        const hash_hex = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256,
                                                         material);
        material.fill(0);

        let key_hash = hex_to_bytes(hash_hex);

        // Quirk inherited from KeeYaOtp: a leading zero byte is dropped, which
        // shortens the key to 31 bytes. Yandex servers require this.
        if (key_hash[0] == 0)
            key_hash = key_hash.subarray(1);

        const counter = Math.trunc(time / this.period);
        const counter_hex = `${counter.toString(16)}`.padStart(16, '0');
        const counter_bytes = hex_to_bytes(counter_hex);

        const mac_hex = GLib.compute_hmac_for_bytes(GLib.ChecksumType.SHA256,
                                                     key_hash,
                                                     counter_bytes);
        const mac = hex_to_bytes(mac_hex);
        key_hash.fill(0);

        // 64-bit dynamic truncation (not the 31-bit one of RFC 4226).
        const offset = mac[mac.length - 1] & 0x0f;
        let value = 0n;
        for (let i = 0; i < 8; ++i)
            value = (value << 8n) | BigInt(mac[offset + i]);
        value &= 0x7fffffffffffffffn;

        let modulus = 1n;
        for (let i = 0; i < this.digits; ++i)
            modulus *= 26n;
        value %= modulus;

        // base-26, least significant letter last
        let result = '';
        for (let i = 0; i < this.digits; ++i) {
            result = ALPHABET[Number(value % 26n)] + result;
            value /= 26n;
        }

        return result;
    }


    // return code and expiry, like TOTP
    code_and_expiry()
    {
        const t = new Date().getTime() / 1000;
        const code = this.code(t);
        const expiry = (Math.trunc(t / this.period) + 1) * this.period;
        return [code, expiry];
    }


    uri()
    {
        // See https://github.com/google/google-authenticator/wiki/Key-Uri-Format
        // plus Yandex's own parameters.
        let query = `secret=${this.secret}`;
        this.wipe_secret();

        query += `&issuer=${encodeURIComponent(this.issuer)}`;

        if (this.digits != DEFAULT_DIGITS)
            query += `&length=${this.digits}`;

        const pin_length = this.pin_length || this.pin.length;
        if (pin_length)
            query += `&pin_length=${pin_length}`;

        if (this.pin)
            query += `&pin=${encodeURIComponent(this.pin)}`;

        if (this.period != DEFAULT_PERIOD)
            query += `&period=${this.period}`;

        return GLib.Uri.join(GLib.UriFlags.NON_DNS,
                             'otpauth',
                             null, // no user
                             this.type.toLowerCase(), // host
                             -1, // port
                             '/' + encodeURIComponent(this.name), // path
                             query,
                             null);
    }


    // return all members as strings, as required by libsecret
    fields_non_destructive()
    {
        return {
            type       : this.type,
            issuer     : this.issuer,
            name       : this.name,
            secret     : this.secret,
            pin        : this.pin || '',
            pin_length : (this.pin_length || this.pin.length || 0).toString(),
            digits     : this.digits.toString(),
            period     : this.period.toString(),
            algorithm  : this.algorithm
        };
    }

}; // class YaOTP
