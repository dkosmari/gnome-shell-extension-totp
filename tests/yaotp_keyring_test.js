/* Сквозная проверка: запись YAOTP в связке ключей -> чтение через secretUtils.js
 * -> вычисление кода. Временная запись удаляется в конце. */

import system from 'system';

import Gio from 'gi://Gio';
import Secret from 'gi://Secret';

import * as SecretUtils from '../secretUtils.js';
import YaOTP from '../yaotp.js';

Gio._promisify(Secret, 'password_clear', 'password_clear_finish');
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_search', 'password_search_finish');
Gio._promisify(Secret, 'password_store', 'password_store_finish');

const SCHEMA = new Secret.Schema('org.gnome.shell.extensions.totp',
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
const ATTRS = {
    type: 'YAOTP',
    issuer: 'YandexTest',
    name: 'integration-' + Math.floor(Date.now() / 1000),
    digits: '8',
    period: '30',
    pin: '7586',
    scheme: 'alpha',
    algorithm: 'SHA-256'
};

let failures = 0;
function check(name, got, expected) {
    const ok = got === expected;
    if (!ok)
        ++failures;
    print(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: получено ${JSON.stringify(got)}, ожидалось ${JSON.stringify(expected)}`}`);
}

let stored = false;
try {
    SecretUtils; // убедимся, что модуль импортируется

    if (!await Secret.password_store(SCHEMA, ATTRS,
                                     '/org/freedesktop/secrets/collection/OTP',
                                     '999:YandexTest:' + ATTRS.name,
                                     SECRET, null))
        throw new Error('не удалось записать элемент');
    stored = true;
    print('записан временный элемент в коллекцию OTP');

    // 1. Как это делает indicator.js: ищем элементы и собираем объекты.
    const items = await SecretUtils.getOTPItems();
    const found = items.filter(i => i.get_attributes().type == 'YAOTP' &&
                                    i.get_attributes().name == ATTRS.name);
    check('найден через secretUtils.getOTPItems', found.length, 1);

    const attrs = found[0].get_attributes();
    const otp = new YaOTP(attrs);
    check('pin пришёл из атрибутов', otp.pin, '7586');

    // 2. Как это делает indicator.js: секрет читается из связки ключей.
    otp.secret = await SecretUtils.getSecret(otp);
    check('секрет прочитан из связки ключей', otp.secret, SECRET);

    // 3. Код на известном времени.
    const code = otp.code(1581064020);
    check('код из связки ключей', code, 'oactmacq');

    // 4. Текущий код — тот же, что считает независимая реализация.
    const fresh = new YaOTP({ ...ATTRS, secret: SECRET });
    const now_code = fresh.code();
    print(`  текущий код: ${now_code} (длина ${now_code.length}, буквы a-z: ${/^[a-z]+$/.test(now_code)})`);
    check('текущий код нужной длины', now_code.length, 8);
    check('текущий код только из a-z', /^[a-z]+$/.test(now_code), true);
}
catch (e) {
    print('ОШИБКА: ' + e.message);
    ++failures;
}
finally {
    if (stored) {
        try {
            await Secret.password_clear(SCHEMA, ATTRS, null);
            const left = await Secret.password_search(SCHEMA,
                                                      { name: ATTRS.name },
                                                      Secret.SearchFlags.NONE, null);
            check('временный элемент удалён', left.length, 0);
        }
        catch (e) {
            print('НЕ УДАЛОСЬ УДАЛИТЬ временный элемент: ' + e.message);
            ++failures;
        }
    }
}

print(`\nИтого: ${failures == 0 ? 'все проверки пройдены' : failures + ' провалов'}`);
system.exit(failures ? 1 : 0);
