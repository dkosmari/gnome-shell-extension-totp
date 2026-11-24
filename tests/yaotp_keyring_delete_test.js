/* Удаление записи YAOTP: обычный случай, «дрейф» атрибутов на диске и
 * отсутствующая запись. Временные элементы удаляются в конце. */

import system from 'system';

import Secret from 'gi://Secret';

import * as SecretUtils from '../secretUtils.js';
import YaOTP from '../yaotp.js';

const SECRET = 'OTPIGD4VRG7AVUDSII24FMESNSWZK';

let failures = 0;
function check(name, got, expected) {
    const ok = got === expected;
    if (!ok)
        ++failures;
    print(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: получено ${JSON.stringify(got)}, ожидалось ${JSON.stringify(expected)}`}`);
}

async function present(name) {
    const items = await SecretUtils.getOTPItems();
    return items.filter(i => i.get_attributes().name == name).length;
}

function make(name) {
    return new YaOTP({ secret: SECRET, digits: 6, scheme: 'digit',
                       name: name, issuer: 'Yandex' });
}

const stamp = Math.floor(Date.now() / 1000);

// 1. Обычное удаление.
const plain_name = `del-plain-${stamp}`;
await SecretUtils.createOTPItem(make(plain_name), 771);
check('создана запись', await present(plain_name), 1);
check('удаление вернуло true',
      await SecretUtils.removeOTPItem(make(plain_name)), true);
check('записи больше нет', await present(plain_name), 0);

// 2. Дрейф атрибутов: на диске остался algorithm из прошлой версии расширения,
//    а объект в руках у вызывающего считает иначе. Раньше это давало
//    «Не удалось удалить пароль».
const drift_name = `del-drift-${stamp}`;
const victim = make(drift_name);
await SecretUtils.createOTPItem(victim, 772);

const items = (await SecretUtils.getOTPItems())
      .filter(i => i.get_attributes().name == drift_name);
check('запись для дрейфа найдена', items.length, 1);
// подменяем атрибуты на диске на «устаревшие»
const stale = items[0].get_attributes();
stale.algorithm = 'SHA-256';
stale.digits = '8';
stale.scheme = 'alpha';
stale.pin = '0000';
check('атрибуты на диске изменены',
      await items[0].set_attributes(SecretUtils.schemaFor ? SecretUtils.schemaFor(victim)
                                     : new Secret.Schema('org.gnome.shell.extensions.totp',
                                                         Secret.SchemaFlags.NONE,
                                                         {
                                                             type: Secret.SchemaAttributeType.STRING,
                                                             issuer: Secret.SchemaAttributeType.STRING,
                                                             name: Secret.SchemaAttributeType.STRING,
                                                             digits: Secret.SchemaAttributeType.INTEGER,
                                                             period: Secret.SchemaAttributeType.INTEGER,
                                                             pin: Secret.SchemaAttributeType.STRING,
                                                             scheme: Secret.SchemaAttributeType.STRING,
                                                             algorithm: Secret.SchemaAttributeType.STRING
                                                         }),
                                         stale, null), true);
check('удаление при дрейфе атрибутов', await SecretUtils.removeOTPItem(make(drift_name)), true);
check('запись с дрейфом удалена', await present(drift_name), 0);

// 3. Несуществующая запись: removeOTPItem честно возвращает false, чтобы
//    вызывающий код показал ошибку, а не сделал вид, что всё удалилось.
check('удаление несуществующей записи -> false',
      await SecretUtils.removeOTPItem(make(`no-such-${stamp}`)), false);

print(`\nИтого: ${failures == 0 ? 'все проверки пройдены' : failures + ' провалов'}`);
system.exit(failures ? 1 : 0);
