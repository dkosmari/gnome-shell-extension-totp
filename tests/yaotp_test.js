/* Проверка yaotp.js: обе схемы, переключатель old(alpha)/new(digit),
 * автоопределение по форме секрета и реальный экспорт Яндекса. */

import system from 'system';

import YaOTP, {detect_scheme, parse_secret,
               SCHEME_OLD, SCHEME_NEW} from '../yaotp.js';

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

// Секрет из файлового экспорта Яндекс ID (18 байт, CRC не сходится): это
// обычный RFC 6238 по всему секрету, цифровой код.
const NEW_SECRET = 'OTPIGD4VRG7AVUDSII24FMESNSWZK';
const NEW_TIME = 1764000000;
// Значение посчитано независимой реализацией (Python hmac/hashlib).
const NEW_EXPECTED = '191379';

const OLD_SECRET = 'LA2V6KMCGYMWWVEW64RNP3JA3IAAAAAAHTSG4HRZPI';

let failures = 0;
function check(name, got, expected) {
    const ok = got === expected;
    if (!ok)
        ++failures;
    print(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: получено ${JSON.stringify(got)}, ожидалось ${JSON.stringify(expected)}`}`);
}

print('--- старая схема (буквы + PIN): векторы Aegis');
for (const v of VECTORS) {
    const otp = new YaOTP({ secret: v.secret, pin: v.pin, digits: v.digits,
                            scheme: SCHEME_OLD });
    check(`pin=${v.pin} t=${v.time}`, otp.code(v.time), v.expected);
}

print('--- автоопределение по форме секрета');
check('26 байт с валидным CRC -> alpha', detect_scheme(OLD_SECRET), SCHEME_OLD);
check('18 байт с битым CRC -> digit', detect_scheme(NEW_SECRET), SCHEME_NEW);
check('16 байт из QR (26 симв.) -> alpha',
      detect_scheme('GEZDGNBVGY3TQOJQGEZDGNBVGY'), SCHEME_OLD);

let threw = false;
try { detect_scheme('GEZDGNBV'); } catch (e) { threw = true; }
check('слишком короткий секрет отвергнут', threw, true);

let threw_crc = false;
try { parse_secret('AA2V6KMCGYMWWVEW64RNP3JA3IAAAAAAHTSG4HRZPI', SCHEME_OLD); }
catch (e) { threw_crc = true; }
check('битый CRC в 26-байтном секрете (явно alpha) отвергнут', threw_crc, true);

print('--- новая схема (цифры): код по всему секрету');
const new_otp = new YaOTP({ secret: NEW_SECRET, digits: 6, scheme: SCHEME_NEW });
check('код совпадает с независимым расчётом', new_otp.code(NEW_TIME), NEW_EXPECTED);
check('код только из цифр', /^[0-9]{6}$/.test(new_otp.code(NEW_TIME)), true);
check('алгоритм по умолчанию SHA-1',
      new YaOTP({ secret: NEW_SECRET, scheme: SCHEME_NEW }).algorithm, 'SHA-1');

print('--- PIN: не нужен в новой схеме, обязателен в старой');
const auto_new = new YaOTP({ secret: NEW_SECRET, digits: 6 });
check('новая схема определена автоматически', auto_new.resolved_scheme, SCHEME_NEW);
check('новая схема без PIN работает', auto_new.code(NEW_TIME), NEW_EXPECTED);
check('новая схема не требует PIN при импорте', auto_new.needs_pin(), false);

const old_without_pin = new YaOTP({ secret: OLD_SECRET, digits: 8, scheme: SCHEME_OLD });
let pin_error = '';
try { old_without_pin.code(1581064020); } catch (e) { pin_error = e.message; }
check('старая схема без PIN — ошибка про PIN', pin_error.includes('PIN'), true);
check('старая схема требует PIN при импорте', old_without_pin.needs_pin(), true);

// После ввода PIN запрос больше не нужен, и код считается.
const old_with_pin = new YaOTP({ secret: OLD_SECRET, digits: 8, scheme: SCHEME_OLD });
old_with_pin.pin = '7586';
check('после ввода PIN запрос снят', old_with_pin.needs_pin(), false);
check('код после ввода PIN', old_with_pin.code(1581064020), 'oactmacq');

// Неверный PIN по длине не проходит проверку (диалог переспросит).
const bad_pin = new YaOTP({ secret: OLD_SECRET, digits: 8, scheme: SCHEME_OLD });
bad_pin.pin = '12';
let bad_error = '';
try { bad_pin.check_pin(); } catch (e) { bad_error = e.message; }
check('короткий PIN отвергнут', bad_error.length > 0, true);

const letters_pin = new YaOTP({ secret: OLD_SECRET, digits: 8, scheme: SCHEME_OLD });
letters_pin.pin = 'abcd';
let letters_error = '';
try { letters_pin.check_pin(); } catch (e) { letters_error = e.message; }
check('нецифровой PIN отвергнут', letters_error.length > 0, true);

print('--- переключатель old(alpha)/new(digit) на одном секрете');
const as_old = new YaOTP({ secret: NEW_SECRET, pin: '1234', digits: 8, scheme: SCHEME_OLD });
const as_new = new YaOTP({ secret: NEW_SECRET, digits: 6, scheme: SCHEME_NEW });
const old_code = as_old.code(NEW_TIME);
const new_code = as_new.code(NEW_TIME);
print(`  old(alpha) = ${old_code}, new(digit) = ${new_code}`);
check('коды различаются', old_code !== new_code, true);
check('new — 6 цифр', /^[0-9]{6}$/.test(new_code), true);
check('old — 8 букв', /^[a-z]{8}$/.test(old_code), true);
check('переключение схемы меняет результат',
      new YaOTP({ secret: NEW_SECRET, pin: '1234', digits: 8,
                  scheme: SCHEME_OLD }).code(NEW_TIME) !== new_code, true);

print('--- разбор URI из файла экспорта');
const yandex_uri = 'otpauth://yaotp/Alexey-Vostrikov?chars=alpha' +
    '&is_2fa=true&is_pin_saved_by_user=false&length=6' +
    '&name=%D0%90%D0%BB%D0%B5%D0%BA%D1%81%D0%B5%D0%B9+%D0%92%D0%BE%D1%81%D1%82%D1%80%D0%B8%D0%BA%D0%BE%D0%B2' +
    '&pin_length=4&secret=' + NEW_SECRET + '&uid=32197447' +
    '&created_at=1707840280&creation_type=with_qr';
const imported = new YaOTP({ uri: yandex_uri });
check('схема: digit (CRC не сходится)', imported.resolved_scheme, SCHEME_NEW);
check('issuer по умолчанию', imported.issuer, 'Yandex');
check('имя из параметра name', imported.name, 'Алексей Востриков');
check('длина кода из length', imported.digits, 6);
check('секрет на месте', imported.secret, NEW_SECRET);
check('код как в приложении', imported.code(NEW_TIME), NEW_EXPECTED);

print('--- явный переключатель перекрывает автоопределение');
check('scheme=alpha в URI',
      new YaOTP({ uri: yandex_uri.replace('secret=', 'scheme=alpha&secret=') })
          .resolved_scheme, SCHEME_OLD);
check('scheme=digit в URI',
      new YaOTP({ uri: yandex_uri.replace('secret=', 'scheme=digit&secret=') })
          .resolved_scheme, SCHEME_NEW);

print('--- round-trip через URI и поля');
const rt = new YaOTP({ secret: OLD_SECRET, pin: '7586', digits: 8,
                       scheme: SCHEME_OLD, name: 'Alex', issuer: 'Yandex' });
const rt_uri = rt.uri();
print(`  ${rt_uri}`);
const rt_back = new YaOTP({ uri: rt_uri });
check('round-trip: код', rt_back.code(1581064020), 'oactmacq');
check('round-trip: PIN', rt_back.pin, '7586');
check('round-trip: схема', rt_back.scheme, SCHEME_OLD);

const fields = new YaOTP({ secret: NEW_SECRET, digits: 6,
                           scheme: SCHEME_NEW }).fields_non_destructive();
check('поля: scheme', fields.scheme, SCHEME_NEW);
check('поля: pin пуст', fields.pin, '');
check('из полей: код', new YaOTP(fields).code(NEW_TIME), NEW_EXPECTED);

print(`\nИтого: ${failures == 0 ? 'все проверки пройдены' : failures + ' провалов'}`);
if (failures)
    system.exit(1);
