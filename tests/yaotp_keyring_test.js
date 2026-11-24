/* Сквозная проверка YAOTP через связку ключей: запись, чтение, PIN, удаление.
 * Временные элементы удаляются в конце. */

import system from 'system';

import Gio from 'gi://Gio';
import Secret from 'gi://Secret';

import * as SecretUtils from '../secretUtils.js';
import YaOTP from '../yaotp.js';

Gio._promisify(Secret, 'password_clear', 'password_clear_finish');
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_search', 'password_search_finish');
Gio._promisify(Secret, 'password_store', 'password_store_finish');

// Схема без атрибута pin: PIN обязан ехать внутри секрета.
const SCHEMA = new Secret.Schema('org.gnome.shell.extensions.totp',
                                 Secret.SchemaFlags.NONE,
                                 {
                                     type      : Secret.SchemaAttributeType.STRING,
                                     issuer    : Secret.SchemaAttributeType.STRING,
                                     name      : Secret.SchemaAttributeType.STRING,
                                     digits    : Secret.SchemaAttributeType.INTEGER,
                                     period    : Secret.SchemaAttributeType.INTEGER,
                                     scheme    : Secret.SchemaAttributeType.STRING,
                                     algorithm : Secret.SchemaAttributeType.STRING
                                 });

// Схема со старым атрибутом pin — для проверки совместимости.
const LEGACY_SCHEMA = new Secret.Schema('org.gnome.shell.extensions.totp',
                                        Secret.SchemaFlags.NONE,
                                        {
                                            type      : Secret.SchemaAttributeType.STRING,
                                            issuer    : Secret.SchemaAttributeType.STRING,
                                            name      : Secret.SchemaAttributeType.STRING,
                                            digits    : Secret.SchemaAttributeType.INTEGER,
                                            period    : Secret.SchemaAttributeType.INTEGER,
                                            pin       : Secret.SchemaAttributeType.STRING,
                                            scheme    : Secret.SchemaAttributeType.STRING,
                                            algorithm : Secret.SchemaAttributeType.STRING
                                        });

const SECRET = 'LA2V6KMCGYMWWVEW64RNP3JA3IAAAAAAHTSG4HRZPI';
const STAMP = Math.floor(Date.now() / 1000);

let failures = 0;
function check(name, got, expected) {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (!ok)
        ++failures;
    print(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: получено ${JSON.stringify(got)}, ожидается ${JSON.stringify(expected)}`}`);
}

const created = [];

async function lookup(name) {
    const items = (await SecretUtils.getOTPItems())
          .filter(i => i.get_attributes().name == name);
    if (!items.length)
        return null;
    const otp = new YaOTP(items[0].get_attributes());
    otp.set_secret_value(await SecretUtils.getSecret(otp));
    return { otp: otp, attrs: items[0].get_attributes() };
}

try {
    // ---------- 1. PIN хранится внутри значения ----------
    const name1 = `yaotp-a-${STAMP}`;
    const source = new YaOTP({ secret: SECRET, pin: '7586', digits: 8,
                               scheme: 'alpha', name: name1, issuer: 'YandexTest' });
    await SecretUtils.createOTPItem(source, 801);
    created.push(name1);

    const back = await lookup(name1);
    check('запись найдена', !!back, true);
    check('PIN НЕ в атрибутах', 'pin' in back.attrs, false);
    check('PIN восстановлен из значения', back.otp.pin, '7586');
    check('секрет восстановлен', back.otp.secret, SECRET);
    check('код считается', back.otp.code(1581064020), 'oactmacq');
    check('схема', back.otp.resolved_scheme, 'alpha');

    // ---------- 2. Новая схема: PIN не нужен ----------
    const name2 = `yaotp-b-${STAMP}`;
    const digit = new YaOTP({ secret: 'OTPIGD4VRG7AVUDSII24FMESNSWZK', digits: 6,
                              scheme: 'digit', name: name2, issuer: 'YandexTest' });
    await SecretUtils.createOTPItem(digit, 802);
    created.push(name2);

    const back2 = await lookup(name2);
    check('новая схема: PIN пуст', back2.otp.pin, '');
    check('новая схема: не требует PIN', back2.otp.needs_pin(), false);
    check('новая схема: код', back2.otp.code(1764000000), '191379');

    // ---------- 3. Совместимость: старая запись с PIN в атрибутах ----------
    const name3 = `yaotp-legacy-${STAMP}`;
    await Secret.password_store(LEGACY_SCHEMA,
                                {
                                    type: 'YAOTP', issuer: 'YandexTest', name: name3,
                                    digits: '8', period: '30', pin: '7586',
                                    scheme: 'alpha', algorithm: 'SHA-256'
                                },
                                '/org/freedesktop/secrets/collection/OTP',
                                `800:YandexTest:${name3}`, SECRET, null);
    created.push(name3);

    const back3 = await lookup(name3);
    check('старая запись: PIN из атрибута', back3.otp.pin, '7586');
    check('старая запись: код считается', back3.otp.code(1581064020), 'oactmacq');

    // ---------- 4. Правка переносит PIN в значение и убирает атрибут ----------
    const edited = new YaOTP({ secret: SECRET, pin: '4321', digits: 8,
                               scheme: 'alpha', name: name3, issuer: 'YandexTest' });
    await SecretUtils.updateOTPItem(back3.otp, edited);
    const after = await lookup(name3);
    check('после правки: PIN из значения', after.otp.pin, '4321');
    check('после правки: атрибута pin нет', 'pin' in after.attrs, false);
}
catch (e) {
    print('ОШИБКА: ' + e.message);
    print(e.stack);
    ++failures;
}
finally {
    for (const name of created) {
        try {
            const found = await lookup(name);
            if (found)
                await SecretUtils.removeOTPItem(new YaOTP(found.attrs));
        }
        catch (e) {
            print(`не удалить ${name}: ${e.message}`);
            ++failures;
        }
    }
    const left = (await SecretUtils.getOTPItems())
          .filter(i => created.includes(i.get_attributes().name));
    check('временные элементы удалены', left.length, 0);
}

print(`\nИтого: ${failures == 0 ? 'все проверки пройдены' : failures + ' провалов'}`);
system.exit(failures ? 1 : 0);
