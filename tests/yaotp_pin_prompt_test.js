/* Диалог PIN: логика переспроса без GTK + реальный диалог, если есть дисплей. */

import system from 'system';

import YaOTP from '../yaotp.js';
import {ask_pin} from '../pins.js';

const OLD_SECRET = 'LA2V6KMCGYMWWVEW64RNP3JA3IAAAAAAHTSG4HRZPI';

let failures = 0;
function check(name, got, expected) {
    const ok = got === expected;
    if (!ok)
        ++failures;
    print(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: получено ${JSON.stringify(got)}, ожидается ${JSON.stringify(expected)}`}`);
}

// Подставной диалог: выдаёт заранее заданные ответы, как будто пользователь
// вводит их по очереди.
function fake_dialog(answers, seen = []) {
    return (args) => {
        seen.push(args);
        return {
            choose: async () => answers.length ? answers.shift() : null
        };
    };
}

print('--- корректный PIN с первого раза');
{
    const otp = new YaOTP({ secret: OLD_SECRET, digits: 8, scheme: 'alpha' });
    const seen = [];
    const pin = await ask_pin(null, otp, fake_dialog(['7586'], seen));
    check('PIN принят', pin, '7586');
    check('записан в запись', otp.pin, '7586');
    check('код считается', otp.code(1581064020), 'oactmacq');
    check('спросили один раз', seen.length, 1);
    check('в вопросе есть имя записи', seen[0].detail.includes('Alex') || seen[0].detail.includes(':'), true);
}

print('--- короткий PIN: переспросить');
{
    const otp = new YaOTP({ secret: OLD_SECRET, digits: 8, scheme: 'alpha' });
    const seen = [];
    const pin = await ask_pin(null, otp, fake_dialog(['12', '7586'], seen));
    check('принят после переспроса', pin, '7586');
    check('спросили дважды', seen.length, 2);
    check('во втором вопросе объяснена причина', seen[1].detail.length > seen[0].detail.length, true);
    check('код считается', otp.code(1581064020), 'oactmacq');
}

print('--- нецифровой PIN: переспросить');
{
    const otp = new YaOTP({ secret: OLD_SECRET, digits: 8, scheme: 'alpha' });
    const seen = [];
    const pin = await ask_pin(null, otp, fake_dialog(['abcd', '7586'], seen));
    check('принят после переспроса', pin, '7586');
    check('спросили дважды', seen.length, 2);
}

print('--- пользователь отказался (Skip)');
{
    const otp = new YaOTP({ secret: OLD_SECRET, digits: 8, scheme: 'alpha' });
    const pin = await ask_pin(null, otp, fake_dialog([null]));
    check('вернулся null', pin, null);
    check('PIN не записан', otp.pin, '');
    check('запись всё ещё требует PIN', otp.needs_pin(), true);
}

print('--- пустой ввод считается отказом');
{
    const otp = new YaOTP({ secret: OLD_SECRET, digits: 8, scheme: 'alpha' });
    const pin = await ask_pin(null, otp, fake_dialog(['']));
    check('вернулся null', pin, null);
    check('PIN не записан', otp.pin, '');
}

print('--- новая схема: ask_pin не вызывается');
{
    const otp = new YaOTP({ secret: 'OTPIGD4VRG7AVUDSII24FMESNSWZK', digits: 6, scheme: 'digit' });
    check('needs_pin() = false', otp.needs_pin(), false);
    check('код и так считается', /^[0-9]{6}$/.test(otp.code(1764000000)), true);
}


print('--- настоящий GTK-диалог (если есть дисплей)');
try {
    const Gtk = (await import('gi://Gtk')).default;
    const {PinDialog} = await import('../pins.js');

    if (!Gtk.init_check()) {
        print('SKIP  нет дисплея');
    }
    else {
        const dialog = new PinDialog({ title: 'test', detail: 'detail', pin_length: 4 });
        dialog.set_text('  7586  ');
        const promise = dialog.choose(null);
        dialog.response(Gtk.ResponseType.OK);
        const value = await promise;
        check('GTK: trim и возврат значения', value, '7586');

        const dialog2 = new PinDialog({ title: 'test', detail: 'detail' });
        const promise2 = dialog2.choose(null);
        dialog2.response(Gtk.ResponseType.CANCEL);
        check('GTK: отмена даёт null', await promise2, null);
    }
}
catch (e) {
    print('SKIP  GTK недоступен: ' + e.message);
}

print(`\nИтого с GTK: ${failures == 0 ? 'все проверки пройдены' : failures + ' провалов'}`);
system.exit(failures ? 1 : 0);
