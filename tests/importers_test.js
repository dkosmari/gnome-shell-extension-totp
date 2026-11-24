/* Импорт из разных бэкапов: Яндекс, Avast Passwords, CSV, список URI. */

import system from 'system';

import {extract_uris, dedupe} from '../importers.js';
import TOTP from '../totp.js';
import HOTP from '../hotp.js';
import YaOTP from '../yaotp.js';

function uri2OTP(uri) {
    try { return new TOTP({ uri: uri }); }
    catch (e1) { try { return new HOTP({ uri: uri }); } catch (e2) { return new YaOTP({ uri: uri }); } }
}

let failures = 0;
function check(name, got, expected) {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (!ok)
        ++failures;
    print(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: получено ${JSON.stringify(got)}, ожидается ${JSON.stringify(expected)}`}`);
}

const T = 1764000000;

// ---------- 1. Яндекс: файл как есть ----------
print('--- Яндекс ID: JSON с techInfo');
const yandex = JSON.stringify([
    { name: 'Gosuslugi', secret: 'Q4TIG4QTJJZ66U3DBDJWVVOJP3AFVK6O',
      techInfo: 'otpauth://totp/Gosuslugi?secret=Q4TIG4QTJJZ66U3DBDJWVVOJP3AFVK6O&issuer=%D0%93%D0%BE%D1%81%D1%83%D1%81%D0%BB%D1%83%D0%B3%D0%B8' },
    { name: 'Alexey-Vostrikov', secret: 'OTPIGD4VRG7AVUDSII24FMESNSWZK',
      techInfo: 'otpauth://yaotp/Alexey-Vostrikov?length=6&pin_length=4&secret=OTPIGD4VRG7AVUDSII24FMESNSWZK' },
]);
let uris = extract_uris(yandex);
check('яндекс: две записи', uris.length, 2);
check('яндекс: yaotp сохранился', uris[1].startsWith('otpauth://yaotp/'), true);

// ---------- 2. Avast Passwords: OTP-токены в общем JSON ----------
print('--- Avast Passwords: токены внутри общего экспорта');
const avast = JSON.stringify({
    logins: [
        { name: 'Почта', loginName: 'a@b.c', pwd: 'x', url: 'https://mail.example' },
        { name: 'Банк', loginName: 'user', pwd: 'y' }
    ],
    otpTokens: [
        { name: 'GitHub', secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', issuer: 'GitHub' },
        { name: 'Google', otpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
          serviceProvider: 'Google', digits: 6, period: 30 }
    ]
});
uris = extract_uris(avast);
check('avast: найдено 2 токена (пароли не тронуты)', uris.length, 2);
const objs = uris.map(uri2OTP);
check('avast: первый TOTP', objs[0].type, 'TOTP');
check('avast: issuer', objs[0].issuer, 'GitHub');
check('avast: имя', objs[0].name, 'GitHub');
check('avast: код считается', /^[0-9]{6}$/.test(objs[0].code(T)), true);

// ---------- 3. Вложенность и разные имена полей ----------
print('--- вложенные контейнеры и синонимы полей');
const nested = JSON.stringify({
    data: { items: [ { kind: 'totp', label: 'AWS', account: 'root',
                       sharedSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
                       digits: 6, period: 30, algorithm: 'SHA256' } ] }
});
uris = extract_uris(nested);
check('вложенный: найдено', uris.length, 1);
check('вложенный: алгоритм SHA256', uris[0].includes('algorithm=SHA256'), true);
check('вложенный: подпись', decodeURIComponent(uris[0].split('/totp/')[1].split('?')[0]), 'AWS:root');

// ---------- 4. HOTP не импортируем ----------
print('--- HOTP пропускается (счётчик не переносим)');
const hotp = JSON.stringify({
    otpTokens: [ { name: 'Old', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', type: 'hotp' } ],
    hotpTokens: [ { name: 'Old2', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } ]
});
check('hotp пропущен', extract_uris(hotp).length, 0);

// ---------- 5. Обычный экспорт паролей не даёт записей ----------
print('--- экспорт паролей без OTP ничего не даёт');
const passwords = JSON.stringify({ logins: [
    { name: 'site', loginName: 'user', pwd: 'secret-password-123456789012345' },
    { name: 'site2', loginName: 'user2', pwd: 'Q4TIG4QTJJZ66U3DBDJWVVOJP3AFVK6O' }
]});
check('пароли не приняты за секреты', extract_uris(passwords).length, 0);

// ---------- 6. CSV ----------
print('--- CSV с заголовком');
const csv = [
    'name,issuer,secret,digits,period',
    'alice@example.com,Example,JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP,6,30',
    'bob@example.com,Other,GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ,8,60'
].join('\n');
uris = extract_uris(csv);
check('csv: две записи', uris.length, 2);
check('csv: 8 цифр во второй', uris[1].includes('digits=8'), true);
check('csv: период во второй', uris[1].includes('period=60'), true);
check('csv: код считается', /^[0-9]{6}$/.test(uri2OTP(uris[0]).code(T)), true);

// ---------- 7. Только URI, с дублями ----------
print('--- список URI с дублями');
const dupes = [
    'otpauth://totp/A?secret=JBSWY3DPEHPK3PXP',
    'otpauth://totp/A?secret=JBSWY3DPEHPK3PXP&created_at=1700000000',
    'otpauth://totp/B?secret=GEZDGNBVGY3TQOJQ'
].join('\n');
check('дубли схлопнуты', extract_uris(dupes).length, 2);

// ---------- 8. Мусор ----------
print('--- мусор не ломает импорт');
check('пустая строка', extract_uris('').length, 0);
check('произвольный текст', extract_uris('hello world').length, 0);
check('битый JSON', extract_uris('[{"name":').length, 0);

print(`\nИтого: ${failures == 0 ? 'все проверки пройдены' : failures + ' провалов'}`);
if (failures)
    system.exit(1);
