/*  yaotp.js
 * Copyright (C) 2025  Daniel K. O.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Yandex OTP ("YAOTP"), as exported by Yandex ID (formerly Yandex.Key) under
 * the `otpauth://yaotp/...` scheme.
 *
 * Entries come in two flavours, and the export parameters don't tell them
 * apart reliably (`chars=alpha` was seen on an entry that shows digits), so
 * the scheme is an explicit setting with an automatic guess as the default:
 *
 *   new / "digit": RFC 6238. The whole decoded secret is the HMAC key, SHA-1,
 *                  31-bit truncation, decimal code. Used for the Yandex ID
 *                  account codes; no PIN involved.
 *
 *   old / "alpha": the proprietary scheme. The key is `SHA-256(pin || key)`,
 *                  the HMAC-SHA-256 output is truncated to 64 bits, and the
 *                  code is base-26 ("a".."z"). Matches the reference
 *                  implementations in KeeYaOtp (C#), libcotp (C) and Aegis.
 *
 * Automatic detection uses the secret shape, which is what the app does too:
 *
 *   16 bytes           key only (from a QR code)        -> old (PIN)
 *   18 bytes, CRC ok   key + PIN length + checksum      -> old (PIN)
 *   18 bytes, CRC bad  the form seen in ID file exports -> new
 *   26+ bytes          key, uid, PIN length, CRC-13     -> old (PIN)
 *
 * Old-scheme test vector (Aegis YAOTPTest):
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
const SHORT_SECRET    = 18;    // key + pin length + checksum (file export)
const DEFAULT_DIGITS_OLD = 8;
const DEFAULT_DIGITS_NEW = 6;
const DEFAULT_PERIOD  = 30;
const DEFAULT_ISSUER  = 'Yandex';
const DEFAULT_PIN_MIN = 4;
const DEFAULT_PIN_MAX = 16;

// Values of the "scheme" attribute; AUTO is what a fresh import gets.
const SCHEME_AUTO  = 'auto';
const SCHEME_OLD   = 'alpha';   // letters, PIN, Yandex.Key
const SCHEME_NEW   = 'digit';   // digits, RFC 6238, Yandex ID

const SCHEMES = [SCHEME_AUTO, SCHEME_OLD, SCHEME_NEW];

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


function decode_base32(base32_secret)
{
    try {
        return Base32.decode(base32_secret.replaceAll(/\s/g, ''), false);
    }
    catch (e) {
        throw new Error(_('Invalid Yandex secret.') + ' ' + e.message);
    }
}


/*
 * Guess the scheme from the shape of the secret. Only used when the entry's
 * scheme is "auto".
 */
export
function detect_scheme(base32_secret)
{
    const bytes = decode_base32(base32_secret);

    if (bytes.length < KEY_BYTES)
        throw new Error(_('Invalid Yandex secret: too short.'));

    if (bytes.length >= FULL_SECRET)
        return checksum_is_valid(bytes.subarray(bytes.length - FULL_SECRET))
            ? SCHEME_OLD : SCHEME_NEW;

    if (bytes.length == SHORT_SECRET)
        return checksum_is_valid(bytes) ? SCHEME_OLD : SCHEME_NEW;

    if (bytes.length == KEY_BYTES)
        return SCHEME_OLD;      // bare key from a QR code: older entry

    return SCHEME_NEW;
}


/*
 * Decode the secret for the given scheme.
 * Returns { key, pin_length }.
 *
 * For the old scheme key is the 16-byte key and pin_length comes from the
 * checksum block (0 if there is none). For the new scheme the whole decoded
 * secret is the key, exactly as in a regular TOTP entry.
 */
export
function parse_secret(base32_secret, scheme = SCHEME_AUTO)
{
    const bytes = decode_base32(base32_secret);

    if (bytes.length < KEY_BYTES)
        throw new Error(_('Invalid Yandex secret: too short.'));

    const resolved = scheme == SCHEME_AUTO ? detect_scheme(base32_secret) : scheme;

    if (resolved == SCHEME_NEW)
        return { key: bytes, pin_length: 0, scheme: SCHEME_NEW };

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
    else if (bytes.length == SHORT_SECRET && checksum_is_valid(bytes)) {
        key = bytes.subarray(0, KEY_BYTES);
        pin_length = (bytes[bytes.length - 2] >> 4) + 1;
    }
    else
        // bare key (from a QR code), no checksum, no PIN length
        key = bytes.subarray(0, KEY_BYTES);

    return { key: key, pin_length: pin_length, scheme: SCHEME_OLD };
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
        digits = 0,
        period = DEFAULT_PERIOD,
        scheme = SCHEME_AUTO,
        algorithm = '',
        uri = null
    } = {})
    {
        super();

        this.type = 'YAOTP';
        this.scheme = normalize_scheme(scheme);
        this.algorithm = algorithm || '';
        this.digits = parseInt(digits) || 0;
        this.period = parseInt(period) || DEFAULT_PERIOD;
        this.pin = pin || '';
        this.issuer = issuer;
        this.name = name;
        this.secret = secret;

        if (!uri) {
            this.#resolve();
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
        this.algorithm  = params.algorithm || '';
        this.scheme     = normalize_scheme(params.scheme);

        // Yandex calls the code length "length"; accept "digits" too.
        this.digits = parseInt(params.length || params.digits) || 0;

        if (!this.secret)
            throw new Error(_('URI is missing the secret.'));

        // Fail early (and loudly) on a corrupt secret, so the user notices at
        // import time rather than when a code is needed.
        this.#resolve();
    }


    // Fill in the defaults that depend on the resolved scheme. An entry read
    // from the keyring has no secret attribute (it is stored separately and
    // fetched on demand), so a missing secret only defers the scheme detection.
    #resolve()
    {
        const info = this.secret ? parse_secret(this.secret, this.scheme) : null;

        this.resolved_scheme = info
            ? info.scheme
            : (this.scheme == SCHEME_AUTO ? null : this.scheme);

        if ((this.resolved_scheme || SCHEME_OLD) == SCHEME_OLD) {
            if (!this.digits)
                this.digits = DEFAULT_DIGITS_OLD;
            this.algorithm = 'SHA-256'; // fixed by the scheme
            this.pin_length = info ? info.pin_length : (this.pin_length || 0);
        }
        else {
            if (!this.digits)
                this.digits = DEFAULT_DIGITS_NEW;
            // Yandex's own codes are plain RFC 6238 with SHA-1; the entry may
            // carry a stale algorithm from an older version of this fork, so it
            // is not used here.
            this.algorithm = 'SHA-1';
            this.pin_length = 0;
        }
    }


    // The old Yandex scheme cannot produce a code without the PIN, and Yandex
    // never exports it, so the PIN is asked for during import rather than left
    // for the user to discover later.
    needs_pin()
    {
        return this.resolved_scheme == SCHEME_OLD && !this.pin;
    }


    /*
     * The PIN travels inside the encrypted secret value, never in item
     * attributes: attributes can be listed without unlocking the collection, and
     * the PIN is part of the key material.
     */
    secret_value()
    {
        const value = this.secret;
        this.wipe_secret();
        if (this.pin)
            return `pin=${this.pin}\n${value}`;
        return value;
    }


    set_secret_value(value)
    {
        const text = `${value || ''}`;
        const newline = text.indexOf('\n');
        if (newline > 0 && text.startsWith('pin=')) {
            this.pin = text.substring(4, newline);
            this.secret = text.substring(newline + 1);
        }
        else {
            // Entries written by an older version kept the PIN in an attribute,
            // which the constructor has already picked up.
            this.secret = text;
        }
    }


    // The PIN is checked lazily: an imported entry may exist before the user
    // typed its PIN, and only code generation actually needs it.
    check_pin()
    {
        if (this.resolved_scheme != SCHEME_OLD)
            return;

        if (!this.pin)
            throw new Error(_('Yandex OTP requires a PIN.') + ' '
                            + _('Pick digits in the scheme setting if the app shows a numeric code.'));

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
        // The indicator assigns the secret after construction, so the scheme may
        // still be undecided here.
        if (!this.resolved_scheme)
            this.#resolve();

        if (this.resolved_scheme == SCHEME_NEW)
            return this.#totp_code(time);
        return this.#pin_code(time);
    }


    // Plain RFC 6238: the whole secret is the key.
    #totp_code(time)
    {
        const secret_bytes = decode_base32(this.secret);
        this.wipe_secret();

        const counter = Math.trunc(time / this.period);
        const counter_hex = `${counter.toString(16)}`.padStart(16, '0');
        const counter_bytes = hex_to_bytes(counter_hex);

        const mac_hex = GLib.compute_hmac_for_bytes(GLib.ChecksumType.SHA1,
                                                     secret_bytes,
                                                     counter_bytes);
        const mac = hex_to_bytes(mac_hex);

        // RFC 4226, section 5.3: 31-bit dynamic truncation
        const offset = mac[mac.length - 1] & 0x0f;
        const view = new DataView(mac.buffer, mac.byteOffset, mac.byteLength);
        const value = view.getUint32(offset) & 0x7fffffff;

        return value.toString().slice(-this.digits).padStart(this.digits, '0');
    }


    #pin_code(time)
    {
        this.check_pin();

        const info = parse_secret(this.secret, SCHEME_OLD);
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
        query += `&scheme=${this.scheme}`;

        if (this.digits)
            query += `&length=${this.digits}`;

        if (this.resolved_scheme == SCHEME_OLD) {
            const pin_length = this.pin_length || this.pin.length;
            if (pin_length)
                query += `&pin_length=${pin_length}`;
            if (this.pin)
                query += `&pin=${encodeURIComponent(this.pin)}`;
        }
        else if (this.algorithm != 'SHA-1') {
            query += `&algorithm=${this.algorithm.replaceAll(/-/g, '')}`;
        }

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
            type      : this.type,
            issuer    : this.issuer,
            name      : this.name,
            secret    : this.secret,
            pin       : this.pin || '',
            scheme    : this.scheme,
            digits    : this.digits.toString(),
            period    : this.period.toString(),
            algorithm : this.algorithm
        };
    }

}; // class YaOTP


// Accept the historical names too, so old keyring entries keep working.
function normalize_scheme(value)
{
    switch ((value || '').toLowerCase()) {
        case SCHEME_OLD:
        case 'yandex':
        case 'pin':
            return SCHEME_OLD;
        case SCHEME_NEW:
        case 'totp':
        case 'digits':
            return SCHEME_NEW;
        case SCHEME_AUTO:
        case '':
            return SCHEME_AUTO;
        default:
            throw new Error(_('Unknown scheme:') + ` ${value}`);
    }
}


export {SCHEME_AUTO, SCHEME_OLD, SCHEME_NEW, SCHEMES};
