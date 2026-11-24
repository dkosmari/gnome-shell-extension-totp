/*  importers.js
 * Copyright (C) 2025  Daniel K. O.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Turns the contents of various backup files into otpauth:// URIs.
 *
 * Supported inputs:
 *
 *   1. A Yandex ID export: a JSON array of objects, where every object has a
 *      ready-made `techInfo` URI, or `name` + base32 `secret`.
 *   2. Any other JSON backup (Avast Passwords, Authenticator Pro, andOTP-like
 *      files, ...): the tree is walked and every object that carries a
 *      base32 secret in a recognisable field becomes an entry. Field names are
 *      matched case-insensitively; nested containers (e.g. `{"otpTokens": [...]}`)
 *      are handled because the walk is recursive.
 *   3. CSV with a header row (`name`, `secret`, `issuer`, `digits`, ...).
 *   4. Plain text with otpauth:// URIs.
 *
 * The importer never invents entries: a secret must look like base32 and be long
 * enough to hold a key, so an ordinary password export produces nothing.
 */

import GLib from 'gi://GLib';

import * as Base32 from './base32.js';
import HOTP from './hotp.js';
import TOTP from './totp.js';
import YaOTP from './yaotp.js';


// strings will be translated by gettext in the frontend
const _ = x => x;


// Field names that hold the shared secret, in order of preference.
const SECRET_KEYS = [
    'secret', 'otpsecret', 'totpsecret', 'sharedsecret', 'secretkey',
    'seed', 'key', 'otp', 'token', 'code'
];

// Field names that hold a human-readable label.
const NAME_KEYS = ['name', 'accountname', 'account', 'label', 'title', 'loginname', 'username', 'login', 'email'];
const ISSUER_KEYS = ['issuer', 'service', 'serviceprovider', 'site', 'website', 'domain', 'realm', 'label'];
const DIGITS_KEYS = ['digits', 'codelength', 'code_length', 'length', 'numberofdigits'];
const PERIOD_KEYS = ['period', 'interval', 'step', 'timeout', 'timestep'];
const ALGO_KEYS = ['algorithm', 'algo', 'hashalgorithm', 'hash'];


const MIN_SECRET_CHARS = 16;    // 16 base32 chars = 10 bytes, below any real key


function get_field(object, keys)
{
    const lower = new Map();
    for (const [key, value] of Object.entries(object))
        lower.set(key.toLowerCase().replaceAll(/[^a-z0-9]/g, ''), value);

    for (const wanted of keys) {
        const key = wanted.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
        if (lower.has(key)) {
            const value = lower.get(key);
            if (value !== null && value !== undefined && `${value}`.trim() !== '')
                return `${value}`.trim();
        }
    }
    return null;
}


function looks_like_base32(text)
{
    const clean = (text || '').replaceAll(/\s/g, '').replaceAll(/=+$/g, '');
    if (clean.length < MIN_SECRET_CHARS)
        return false;
    if (!/^[A-Za-z2-7]+$/.test(clean))
        return false;
    try {
        return Base32.decode(clean, false).length >= 10;
    }
    catch (e) {
        return false;
    }
}


function normalize_algorithm(value)
{
    if (!value)
        return null;
    const up = `${value}`.toUpperCase().replaceAll(/[^A-Z0-9]/g, '');
    switch (up) {
        case 'SHA1':   return 'SHA1';
        case 'SHA256': return 'SHA256';
        case 'SHA512': return 'SHA512';
        default:       return null;
    }
}


function make_uri({name, issuer, secret, digits, period, algorithm})
{
    let path;
    const issuer_is_name = issuer && name &&
          issuer.toLowerCase() == name.toLowerCase();
    if (issuer && name && !issuer_is_name &&
        !name.toLowerCase().startsWith(issuer.toLowerCase() + ':'))
        path = `${issuer}:${name}`;
    else
        path = name || issuer || 'OTP';

    let query = `secret=${secret}`;
    if (issuer)
        query += `&issuer=${encodeURIComponent(issuer)}`;
    if (digits)
        query += `&digits=${digits}`;
    if (period && period != 30)
        query += `&period=${period}`;
    if (algorithm && algorithm != 'SHA1')
        query += `&algorithm=${algorithm}`;

    return `otpauth://totp/${encodeURIComponent(path)}?${query}`;
}


/*
 * Build a URI from an object that carries a secret, or null.
 */
export
function object_to_uri(object, type_hint = null)
{
    if (!object || typeof object != 'object' || Array.isArray(object))
        return null;

    const secret = get_field(object, SECRET_KEYS);
    if (!secret || !looks_like_base32(secret))
        return null;

    // A ready-made URI wins over any guessing.
    for (const key of ['techinfo', 'uri', 'otpauth', 'otpauthuri', 'url']) {
        const value = get_field(object, [key]);
        if (value && value.startsWith('otpauth://'))
            return value;
    }

    // Only time-based codes make sense here; skip HOTP counters. An explicit
    // type on the entry wins over the hint taken from its container's name.
    const own_type = get_field(object, ['type', 'kind', 'method']);
    const type = own_type || type_hint;
    if (type && /hotp|counter/i.test(type))
        return null;

    return make_uri({
        name: get_field(object, NAME_KEYS),
        issuer: get_field(object, ISSUER_KEYS),
        secret: secret.replaceAll(/\s/g, '').toUpperCase().replaceAll(/=+$/g, ''),
        digits: get_field(object, DIGITS_KEYS),
        period: get_field(object, PERIOD_KEYS),
        algorithm: normalize_algorithm(get_field(object, ALGO_KEYS))
    });
}


/*
 * Recursively collect URIs from a parsed JSON value.
 */
function walk(value, uris, type_hint = null, depth = 0)
{
    if (depth > 12 || value === null || typeof value != 'object')
        return;

    if (Array.isArray(value)) {
        for (const item of value)
            walk(item, uris, type_hint, depth + 1);
        return;
    }

    const uri = object_to_uri(value, type_hint);
    if (uri) {
        uris.push(uri);
        return;         // no need to look inside an entry
    }

    // Not an entry itself: descend, remembering the key as a type hint so that
    // {"hotpTokens": [...]} is skipped while {"otpTokens": [...]} is taken.
    for (const [key, child] of Object.entries(value)) {
        const hint = /hotp|counter/i.test(key) ? 'hotp'
            : /otp|totp|authenticator|token|twofactor|2fa/i.test(key) ? 'totp'
            : type_hint;
        walk(child, uris, hint, depth + 1);
    }
}


function parse_csv_line(line)
{
    const cells = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; ++i) {
        const ch = line[i];
        if (quoted) {
            if (ch == '"' && line[i + 1] == '"') { cell += '"'; ++i; }
            else if (ch == '"') quoted = false;
            else cell += ch;
        }
        else if (ch == '"') quoted = true;
        else if (ch == ',' || ch == ';' || ch == '\t') { cells.push(cell); cell = ''; }
        else cell += ch;
    }
    cells.push(cell);
    return cells.map(x => x.trim());
}


function csv_to_uris(text)
{
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2)
        return [];

    const header = parse_csv_line(lines[0]).map(h => h.toLowerCase());
    const has_secret = header.some(h => SECRET_KEYS.includes(h.replaceAll(/[^a-z0-9]/g, '')));
    if (!has_secret)
        return [];

    const uris = [];
    for (const line of lines.slice(1)) {
        const cells = parse_csv_line(line);
        if (cells.length != header.length)
            continue;
        const object = {};
        header.forEach((key, i) => object[key] = cells[i]);
        const uri = object_to_uri(object);
        if (uri)
            uris.push(uri);
    }
    return uris;
}


/*
 * Convert the contents of a backup file into otpauth:// URIs.
 * Returns an array (possibly empty) — never throws on unknown formats.
 */
export
function extract_uris(text)
{
    if (typeof text != 'string' || !text.trim())
        return [];

    const trimmed = text.trim();

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            const uris = [];
            walk(JSON.parse(trimmed), uris);
            if (uris.length)
                return dedupe(uris);
        }
        catch (e) {
            // not JSON after all: fall through to the other formats
        }
    }

    // URIs anywhere in the text (also covers screenshots of migration QR codes).
    // GLib.Uri.list_extract_uris() is very permissive and happily returns plain
    // sentences and CSV lines, so only real otpauth:// URIs are kept.
    const from_uris = GLib.Uri.list_extract_uris(text)
          .filter(uri => uri.startsWith('otpauth://'));
    if (from_uris.length)
        return dedupe(from_uris);

    const from_csv = csv_to_uris(text);
    if (from_csv.length)
        return dedupe(from_csv);

    return [];
}


/*
 * OTP object from a URI, or an exception.
 *
 * A URI that parses but carries no secret would otherwise become a silently
 * empty entry, so the result is validated here — one place, used by the import
 * flow and by the drag-and-drop/paste paths.
 */


/*
 * Explain why a URI cannot be imported. Used for diagnostics instead of a bare
 * "no secret", because the reason is usually actionable.
 */
function explain_unsupported(text)
{
    // Avanpost Authenticator hands out a binding QR: the TOTP secret is issued by
    // the server after the app completes the binding, so it is absent here and
    // no third-party authenticator can use this URI. Avanpost's separate
    // "software TOTP" method does emit a standard otpauth URI with a secret.
    if (/[?&](idpId|transactionId|randomBind|randomUnbind)=/.test(text))
        return _('This is an Avanpost Authenticator binding QR: the secret is issued by the server, '
               + 'so it cannot be used outside that app. Ask your administrator for a "software TOTP" '
               + 'binding, which produces a standard otpauth QR code.');

    if (/[?&]secret=(&|$)/.test(text))
        return _('The URI has an empty "secret" parameter.');

    if (!/[?&]secret=/.test(text))
        return _('The URI contains no secret.');

    return null;
}


export
function otp_from_uri(uri)
{
    const text = typeof uri == 'string' ? uri.trim() : '';
    if (!text.startsWith('otpauth://'))
        throw new Error(_('Not an "otpauth://" URI.'));

    let otp = null;
    const errors = [];
    for (const make of [u => new TOTP({uri: u}),
                        u => new HOTP({uri: u}),
                        u => new YaOTP({uri: u})]) {
        try {
            otp = make(text);
            break;
        }
        catch (e) {
            errors.push(e.message);
        }
    }

    if (!otp)
        throw new Error(_('Unsupported OTP URI:') + ' ' + errors.join(' | '));

    if (!otp.secret)
        throw new Error(explain_unsupported(text) || _('The URI contains no secret.'));

    return otp;
}


export
function dedupe(uris)
{
    const seen = new Set();
    const result = [];
    for (const uri of uris) {
        if (!uri.startsWith('otpauth://'))
            continue;
        const key = uri.replaceAll(/&(created_at|creation_type|uid|account_id)=[^&]*/g, '');
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(uri);
    }
    return result;
}
