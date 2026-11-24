/* Проверка yaotp.js на векторах из Aegis YAOTPTest и на реальном экспорте. */

import system from 'system';

import YaOTP from '../yaotp.js';
import * as YaOtpMod from '../yaotp.js';

const VECTORS = [
    { pin: '5239', secret: '6SB2IKNM6OBZPAVBVTOHDKS4FAAAAAAADFUTQMBTRY',
      time: 1641559648, digits: 8, expected: 'umozdicq' },
    { pin: '7586', secret: 'LA2V6KMCGYMWWVEW64RNP3JA3IAAAAAAHTSG4HRZPI',
      time: 1581064020, digits: 8, expected: 'oactmacq' },
    { pin: '7586', secret: 'LA2V6KMCGYMWWVEW64RNP3JA3IAAAAAAHTSG4HRZPI',
      time: 1581090810, digits: 8, expected: 'wemdwrix' },
    { pin: '5210481216086702', secret: 'JBGSAU4G7IEZG6OY4UAXX62JU4AAAAAAHTSG4HXU3M',
      time: 1581091469, digits: 8, expected: 'dfrpywob' },
    { pin: '5210481216086702', secret: 'JBGSAU4G7IEZG6OY4UAXX62JU4AAAAAAHTSG4HXU3M',
      time: 1581093059, digits: 8, expected: 'vunyprpd' },
];

let failures = 0;
function check(name, got, expected) {
    const ok = got === expected;
    if (!ok)
        ++failures;
    print(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: получено ${JSON.stringify(got)}, ожидалось ${JSON.stringify(expected)}`}`);
}

print('--- векторы Aegis (эталон алгоритма)');
for (const v of VECTORS) {
    const otp = new YaOTP({ secret: v.secret, pin: v.pin, digits: v.digits });
    check(`pin=${v.pin} t=${v.time}`, otp.code(v.time), v.expected);
}

print('--- валидация секретов');
const good = 'LA2V6KMCGYMWWVEW64RNP3JA3IAAAAAAHTSG4HRZPI';
const info = YaOtpMod.parse_secret(good);
check('pin_length из 26-байтного секрета', info.pin_length, 4);
check('длина ключа', info.key.length, 16);

const bad = 'AA2V6KMCGYMWWVEW64RNP3JA3IAAAAAAHTSG4HRZPI';
let threw = false;
try { YaOtpMod.parse_secret(bad); } catch (e) { threw = true; }
check('битый CRC отвергнут', threw, true);

let threw2 = false;
try { YaOtpMod.parse_secret('AA2V6KMCGJA3IAA'); } catch (e) { threw2 = true; }
check('слишком короткий секрет отвергнут', threw2, true);

// Короткий вариант экспорта (18 байт) приложения Яндекса: контрольная сумма в
// нём может не сходиться, такой секрет принимается, а длина PIN берётся из URI.
const short_secret = 'OTPIGD4VRG7AVUDSII24FMESNSWZK';
const short_info = YaOtpMod.parse_secret(short_secret);
check('18-байтный секрет принят', short_info.key.length, 16);

print('--- PIN обязателен и проверяется');
const noPin = new YaOTP({ secret: good, digits: 8 });
let pinError = '';
try { noPin.code(1581064020); } catch (e) { pinError = e.message; }
check('без PIN — ошибка', pinError.includes('PIN'), true);

const wrongLen = new YaOTP({ secret: good, pin: '12345', digits: 8 });
let lenError = '';
try { wrongLen.code(1581064020); } catch (e) { lenError = e.message; }
check('неверная длина PIN — ошибка', lenError.includes('PIN'), true);

print('--- разбор URI из файла экспорта Яндекса');
const yandex_uri = 'otpauth://yaotp/Alexey-Vostrikov?chars=alpha' +
    '&is_2fa=true&is_pin_saved_by_user=false&length=6' +
    '&machine_readable_login=alexey-vostrikov' +
    '&name=%D0%90%D0%BB%D0%B5%D0%BA%D1%81%D0%B5%D0%B9+%D0%92%D0%BE%D1%81%D1%82%D1%80%D0%B8%D0%BA%D0%BE%D0%B2' +
    '&pin_length=4&secret=OTPIGD4VRG7AVUDSII24FMESNSWZK&uid=32197447' +
    '&created_at=1707840280&creation_type=with_qr';
const imported = new YaOTP({ uri: yandex_uri });
check('issuer по умолчанию', imported.issuer, 'Yandex');
check('имя из параметра name', imported.name, 'Алексей Востриков');
check('длина кода из length', imported.digits, 6);
check('длина PIN из pin_length', imported.pin_length, 4);
check('секрет на месте', imported.secret, 'OTPIGD4VRG7AVUDSII24FMESNSWZK');

print('--- обратный экспорт в URI и повторный импорт');
const withPin = new YaOTP({ secret: good, pin: '7586', digits: 8, name: 'Alex', issuer: 'Yandex' });
const uri2 = withPin.uri();
print(`  ${uri2}`);
const reimported = new YaOTP({ uri: uri2 });
check('round-trip: код совпадает', reimported.code(1581064020), 'oactmacq');
check('round-trip: PIN', reimported.pin, '7586');

print(`\nИтого: ${failures == 0 ? 'все проверки пройдены' : failures + ' провалов'}`);
if (failures)
    system.exit(1);
