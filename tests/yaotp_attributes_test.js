/* Проверка пути «атрибуты libsecret -> объект -> код», как это делают
 * indicator.js и prefs.js (без обращения к связке ключей). */

import system from 'system';

import YaOTP from '../yaotp.js';

let failures = 0;
function check(name, got, expected) {
    const ok = got === expected;
    if (!ok)
        ++failures;
    print(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: получено ${JSON.stringify(got)}, ожидалось ${JSON.stringify(expected)}`}`);
}

// libsecret отдаёт все атрибуты строками.
const attributes = {
    type: 'YAOTP',
    issuer: 'Yandex',
    name: 'Alexey',
    digits: '8',
    period: '30',
    pin: '7586',
    algorithm: 'SHA-256',
    secret: 'LA2V6KMCGYMWWVEW64RNP3JA3IAAAAAAHTSG4HRZPI',
};

const otp = new YaOTP(attributes);

// fields()/code() затирают секрет по замыслу (как в otp.js), поэтому поля
// снимаем до вычисления кода.
const fields = otp.fields_non_destructive();

check('код из атрибутов', otp.code(1581064020), 'oactmacq');
check('тип', otp.type, 'YAOTP');
check('время-зависимый (есть period)', otp.period, 30);
check('секрет затёрт после выдачи кода', /^A+$/.test(otp.secret), true);
check('round-trip: secret', fields.secret, attributes.secret);
check('round-trip: pin', fields.pin, '7586');
check('round-trip: pin_length из секрета', fields.pin_length, '4');
check('round-trip: digits', fields.digits, '8');
check('round-trip: algorithm', fields.algorithm, 'SHA-256');

// Повторная сборка из полей (как при редактировании записи).
const again = new YaOTP(fields);
check('код после round-trip', again.code(1581090810), 'wemdwrix');

// Код должен обновляться со временем. Каждый вызов code() затирает секрет,
// поэтому на каждую проверку создаём новый объект.
function code_at(t) {
    return new YaOTP(attributes).code(t);
}
const t1 = 1581064020;
check('код в следующем периоде отличается', code_at(t1) !== code_at(t1 + 30), true);
check('код повторяем в том же периоде', code_at(t1), 'oactmacq');

print(`\nИтого: ${failures == 0 ? 'все проверки пройдены' : failures + ' провалов'}`);
if (failures)
    system.exit(1);
