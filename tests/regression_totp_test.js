/* Регрессия: существующие записи (TOTP/HOTP) по-прежнему читаются и дают коды
 * после добавления YAOTP. Ничего не изменяет. */

import system from 'system';

import * as SecretUtils from '../secretUtils.js';
import TOTP from '../totp.js';
import HOTP from '../hotp.js';
import YaOTP from '../yaotp.js';

let failures = 0;
const items = await SecretUtils.getOTPItems();
print(`найдено записей: ${items.length}`);

for (const item of items) {
    const attrs = item.get_attributes();
    const label = item.get_label();
    const type = attrs.type;

    let otp = null;
    if (type == 'TOTP')
        otp = new TOTP(attrs);
    else if (type == 'HOTP')
        otp = new HOTP(attrs);
    else if (type == 'YAOTP')
        otp = new YaOTP(attrs);

    if (!otp) {
        print(`FAIL  неизвестный тип ${type}: ${label}`);
        ++failures;
        continue;
    }

    try {
        otp.secret = await SecretUtils.getSecret(otp);
        let code;
        if (type == 'HOTP')
            code = '(HOTP, счётчик не трогаем)';
        else
            code = otp.code();
        print(`PASS  ${type.padEnd(5)} ${label} -> ${code}`);
    }
    catch (e) {
        print(`FAIL  ${type} ${label}: ${e.message}`);
        ++failures;
    }
}

print(`\nИтого: ${failures == 0 ? 'все записи в порядке' : failures + ' проблем'}`);
system.exit(failures ? 1 : 0);
