/* Поиск фактической схемы кода Яндекс ID по коду из приложения.
 *
 * Использование:
 *   gjs -m tests/yaotp_scheme_search.js <файл-с-URI> [--now <unix-время>]
 *
 * Скрипт спрашивает PIN и код, который сейчас показывает приложение, и
 * перебирает варианты: производные ключа (с PIN и без), SHA-256/SHA-1,
 * усечение 64- и 31-битное, коды десятичные и base-26, периоды 30 и 60 с
 * окном по времени (часы телефона могут убегать).
 *
 * --now и --code позволяют прогнать самопроверку на опубликованных векторах.
 */

import GLib from "gi://GLib";
import system from "system";

import * as Base32 from '../base32.js';


function read_line(prompt) {
    printerr(prompt);
    const ch = GLib.IOChannel.unix_new(0);
    const [status, line] = ch.read_line();
    if (status != 1 || line === null)
        throw new Error('ввод прерван');
    return line.replace(/[\r\n]+$/, '');
}


function hex_to_bytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; ++i)
        out[i] = parseInt(hex.substring(2 * i, 2 * i + 2), 16);
    return out;
}


function sha256(bytes) {
    return hex_to_bytes(GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes));
}


function hmac(algo, key, data) {
    const hex = GLib.compute_hmac_for_bytes(algo, key, data);
    return hex_to_bytes(hex);
}


function counter_bytes(counter) {
    const out = new Uint8Array(8);
    let v = BigInt(counter);
    for (let i = 7; i >= 0; --i) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}


// 64-битная выборка: offset = mac[31] & 0x0f, 8 байт, старший бит сброшен.
// Для коротких MAC (SHA-1, 20 байт) выборка может выйти за пределы — тогда null.
function truncate64(mac) {
    const offset = mac[mac.length - 1] & 0x0f;
    if (offset + 8 > mac.length)
        return null;
    let value = 0n;
    for (let i = 0; i < 8; ++i)
        value = (value << 8n) | BigInt(mac[offset + i]);
    return value & 0x7fffffffffffffffn;
}


// 31-битная выборка из RFC 4226 (нужны 4 байта от offset, иначе null).
function truncate31(mac) {
    const offset = mac[mac.length - 1] & 0x0f;
    if (offset + 4 > mac.length)
        return null;
    const view = new DataView(mac.buffer, mac.byteOffset, mac.byteLength);
    return BigInt(view.getUint32(offset) & 0x7fffffff);
}


const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';


function base26(value, digits) {
    let v = value;
    let out = '';
    for (let i = 0; i < digits; ++i) {
        out = ALPHABET[Number(v % 26n)] + out;
        v /= 26n;
    }
    return out;
}


function decimal(value, digits) {
    const mod = 10n ** BigInt(digits);
    return (value % mod).toString().padStart(digits, '0');
}


function key_candidates(secret_bytes, pin_text, pin_length) {
    const pin = new TextEncoder().encode(pin_text);
    const key16 = secret_bytes.subarray(0, 16);
    const list = [];

    const with_pin = new Uint8Array(pin.length + 16);
    with_pin.set(pin, 0);
    with_pin.set(key16, pin.length);

    const hash = sha256(with_pin);
    list.push({ name: `SHA256(pin||key) [pin=${pin.length}]`, bytes: hash });
    if (hash[0] == 0)
        list.push({ name: `SHA256(pin||key) без нулевого байта (31)`, bytes: hash.subarray(1) });

    // Варианты без PIN: секрет как ключ.
    list.push({ name: 'key без PIN (16)', bytes: key16 });
    list.push({ name: 'весь секрет как ключ', bytes: secret_bytes });

    // PIN как UTF-16 и с солью из секрета.
    const pin16 = new Uint8Array(pin_text.length * 2);
    for (let i = 0; i < pin_text.length; ++i) {
        pin16[2 * i] = pin_text.charCodeAt(i) & 0xff;
        pin16[2 * i + 1] = 0;
    }
    const with_pin16 = new Uint8Array(pin16.length + 16);
    with_pin16.set(pin16, 0);
    with_pin16.set(key16, pin16.length);
    list.push({ name: 'SHA256(pin-utf16||key)', bytes: sha256(with_pin16) });

    return list;
}


function parse_uri(uri) {
    const at = uri.indexOf('?');
    const query = at >= 0 ? uri.substring(at + 1) : '';
    const params = {};
    for (const entry of query.split('&')) {
        const eq = entry.indexOf('=');
        if (eq > 0)
            params[entry.substring(0, eq)] = decodeURIComponent(entry.substring(eq + 1));
    }
    return params;
}


function main() {
    const args = ARGV;
    const positional = args.filter(a => !a.startsWith('--'));
    let uri_file = positional[0];
    let now = Math.trunc(new Date().getTime() / 1000);
    let given_code = null;
    let pin_override = null;

    for (let i = 0; i < args.length; ++i) {
        if (args[i] == '--now')
            now = parseInt(args[i + 1]);
        if (args[i] == '--code')
            given_code = args[i + 1];
        if (args[i] == '--pin')
            pin_override = args[i + 1];
    }

    let uri;
    if (uri_file) {
        const [ok, contents] = GLib.file_get_contents(uri_file);
        if (!ok)
            throw new Error(`не прочитать файл ${uri_file}`);
        uri = new TextDecoder().decode(contents).trim().split('\n')[0];
    }
    else {
        uri = read_line('URI otpauth://yaotp/...: ');
    }

    const params = parse_uri(uri);
    const secret_bytes = Base32.decode(params.secret.replace(/\s/g, ''), false);
    print(`секрет: ${params.secret} (${secret_bytes.length} байт), экспорт: ` +
          `chars=${params.chars || '-'} length=${params.length || '-'} ` +
          `pin_length=${params.pin_length || '-'}`);

    const pin = pin_override !== null ? pin_override : read_line('PIN из приложения: ');
    const raw_code = given_code === null
          ? read_line('Код, который сейчас показывает приложение: ')
          : given_code;
    // В приложении код могут показывать с пробелом посередине.
    const app_code = raw_code.replace(/[\s-]/g, '');

    print(`время: ${now}, код приложения: ${app_code}\n`);

    const keys = key_candidates(secret_bytes, pin, params.pin_length);
    const algos = [
        ['SHA-256', GLib.ChecksumType.SHA256],
        ['SHA-1', GLib.ChecksumType.SHA1],
    ];
    const periods = [30, 60, 15];

    let matches = [];
    for (const key of keys) {
        for (const [algo_name, algo] of algos) {
            for (const period of periods) {
                const base = Math.trunc(now / period);
                for (let delta = -10; delta <= 10; ++delta) {
                    const counter = base + delta;
                    if (counter < 0)
                        continue;
                    const mac = hmac(algo, key.bytes, counter_bytes(counter));
                    const v64 = truncate64(mac);
                    const v31 = truncate31(mac);

                    const candidates = [];
                    if (v64 !== null) {
                        candidates.push(
                            [`base26/8 (эталон KeeYaOtp)`, base26(v64, 8)],
                            [`base26/6`, base26(v64, 6)],
                            [`base26/8, последние 6`, base26(v64, 8).slice(-6)],
                            [`10-ричный/6 из 64-бит`, decimal(v64, 6)],
                            [`10-ричный/8 из 64-бит`, decimal(v64, 8)]);
                    }
                    if (v31 !== null) {
                        candidates.push(
                            [`10-ричный/6 из 31-бит (RFC 4226)`, decimal(v31, 6)],
                            [`10-ричный/8 из 31-бит`, decimal(v31, 8)]);
                    }

                    for (const [scheme, code] of candidates) {
                        if (code.toLowerCase() == app_code.toLowerCase())
                            matches.push({ scheme, algo: algo_name, period, delta, key: key.name, code });
                    }
                }
            }
        }
    }

    if (!matches.length) {
        print('СОВПАДЕНИЙ НЕТ. Проверяемые варианты:');
        for (const key of keys)
            print(`  ключ: ${key.name} (${key.bytes.length} байт)`);
        print('  алгоритмы: SHA-256, SHA-1; периоды: 30/60/15 с; окно ±10 периодов');
        print('  коды: base26/8, base26/6, 10-ричные 6/8 из 64- и 31-битного усечения');

        // Диагностика: что мы получаем на текущий момент по каждому варианту.
        print('\nНаши коды для текущей эпохи (для сверки глазами):');
        const key = keys[0];
        for (const [algo_name, algo] of algos) {
            for (const period of periods) {
                const counter = Math.trunc(now / period);
                const mac = hmac(algo, key.bytes, counter_bytes(counter));
                const v64 = truncate64(mac);
                const v31 = truncate31(mac);
                const parts = [];
                if (v64 !== null)
                    parts.push(`base26/8=${base26(v64, 8)}`,
                               `base26/6=${base26(v64, 6)}`,
                               `10-ричный/6=${decimal(v64, 6)}`);
                if (v31 !== null)
                    parts.push(`10-ричный/6-31бит=${decimal(v31, 6)}`);
                print(`  ${algo_name} период ${period}: ` + parts.join('  '));
            }
        }
        return 1;
    }

    print('НАЙДЕННЫЕ ВАРИАНТЫ (все дают код приложения):');
    for (const m of matches)
        print(`  ${m.scheme} | ${m.algo} | период ${m.period} | сдвиг ${m.delta} | ключ: ${m.key}`);
    return 0;
}


const status = main();
if (status)
    system.exit(status);
