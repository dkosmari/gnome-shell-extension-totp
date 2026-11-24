/* Импорт из разных бэкапов: Яндекс, Avast Passwords, CSV, список URI. */

import system from 'system';

import {extract_uris, dedupe, otp_from_uri} from '../importers.js';
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

// ---------- 9. otp_from_uri: пустой URI не создаёт запись ----------
print('--- валидация URI при импорте');
{
    const ott = otp_from_uri('otpauth://totp/Mozilla:a%40b.c?secret=NBCVO6BSHBVWG42JMVZDO4KJMRHEQQLU&issuer=Mozilla');
    check('годный URI разобран', [ott.type, ott.issuer], ['TOTP', 'Mozilla']);
    check('код считается', /^[0-9]{6}$/.test(ott.code(T)), true);

    const bad = [
        ['пустая строка', ''],
        ['undefined', undefined],
        ['не URI', 'hello'],
        ['URI без секрета', 'otpauth://totp/Name?issuer=X'],
        ['неизвестный тип', 'otpauth://motp/Name?secret=NBCVO6BSHBVWG42JMVZDO4KJMRHEQQLU'],
    ];
    for (const [label, value] of bad) {
        let threw = false;
        try { otp_from_uri(value); } catch (e) { threw = true; }
        check(`${label} отвергнут`, threw, true);
    }

    const ya = otp_from_uri('otpauth://yaotp/X?length=6&secret=OTPIGD4VRG7AVUDSII24FMESNSWZK');
    check('yaotp через otp_from_uri', ya.type, 'YAOTP');

    // Привязка Avanpost Authenticator: секрет выдаёт сервер, его в QR нет.
    const avanpost = 'otpauth://totp/https://fam.example.ru:user?algorithm=SHA1&digits=6'
        + '&issuer=https%3A%2F%2Ffam.example.ru&period=30&secret='
        + '&userId=3805166f&transactionId=efad7e8d&randomBind=abc&randomUnbind=def'
        + '&idpId=e2b3d955&enc=SHA1';
    let avanpost_error = '';
    try { otp_from_uri(avanpost); } catch (e) { avanpost_error = e.message; }
    check('Avanpost: отклонён с объяснением', avanpost_error.includes('Avanpost'), true);
    check('Avanpost: сказано про программный TOTP', avanpost_error.includes('software TOTP'), true);

    // Пустой secret без признаков Avanpost — отдельное сообщение.
    let empty_error = '';
    try { otp_from_uri('otpauth://totp/X?secret=&issuer=Y'); } catch (e) { empty_error = e.message; }
    check('пустой secret: своё сообщение', empty_error.includes('empty'), true);
}

print(`\nИтого: ${failures == 0 ? 'все проверки пройдены' : failures + ' провалов'}`);
if (failures)
    system.exit(1);
