/* indicator.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


import GObject from 'gi://GObject';
import Secret from 'gi://Secret';
import St from 'gi://St';

import * as Main      from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as SecretUtils from './secretUtils.js';
import TOTP from './totp.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';


function copyToClipboard(text)
{
    // this runs inside gnome-shell, so we use St
    let clipboard = St.Clipboard.get_default();
    clipboard.set_text(St.ClipboardType.PRIMARY, text);
    clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
    Main.notify(_('OTP code copied to clipboard.'), text);
}


function makeLabel({issuer, name})
{
    return `${issuer}: ${name}`;
}


export default
class Indicator extends PanelMenu.Button {

    static {
        GObject.registerClass(this);
    }


    #ext;
    #lock_item;
    #totp_items = [];
    #unlock_item;


    constructor(ext)
    {
        super();

        this.#ext = ext;

        this.add_child(
            new St.Icon({
                icon_name: 'changes-prevent-symbolic',
                style_class: 'system-status-icon'
            })
        );

        this.#lock_item = this.menu.addAction(_('Lock OTP secrets'),
                                              this.lockTOTPSecrets.bind(this),
                                              'changes-prevent-symbolic');

        this.#unlock_item = this.menu.addAction(_('Unlock OTP secrets...'),
                                                this.unlockTOTPSecrets.bind(this),
                                                'changes-allow-symbolic');
        this.#unlock_item.visible = !this.#lock_item.visible;

        this.menu.addAction(_('Settings...'),
                            this.editTOTPSecrets.bind(this),
                            'preferences-other-symbolic');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('OTP Secrets')));


        Main.panel.addToStatusArea(ext.uuid, this);
    }


    _init()
    {
        super._init(0.5, 'TOTP');
    }


    destroy()
    {
        this.#lock_item.destroy();
        this.#lock_item = null;

        this.#unlock_item.destroy();
        this.#unlock_item = null;

        this.clearTOTPItems();
        super.destroy();
    }


    async _onOpenStateChanged(menu, is_open)
    {
        super._onOpenStateChanged(menu, is_open);

        try  {
            if (is_open) {
                let locked = await SecretUtils.isOTPCollectionLocked();
                this.#lock_item.visible = !locked;
                this.#unlock_item.visible = locked;
                await this.refreshTOTPItems();
            } else
                this.clearTOTPItems();
        }
        catch (e) {
            logError(e);
        }
    }


    async lockTOTPSecrets()
    {
        try {
            if (!await SecretUtils.lockOTPCollection())
                // Sometimes the keyring locks just fine, yet it reports incorrectly that
                // nothing was locked. So we double check here.
                if (!await SecretUtils.isOTPCollectionLocked())
                    Main.notify(_('Failed to lock OTP secrets.'));
        }
        catch (e) {
            logError(e);
            Main.notifyError(_('Error locking OTP secrets.'), _(e.message));
        }
    }


    async unlockTOTPSecrets()
    {
        try {
            if (!await SecretUtils.unlockOTPCollection())
                // Sometimes the keyring unlocks just fine, yet it reports incorrectly
                // that nothing was unlocked. So we double check here.
                if (await SecretUtils.isOTPCollectionLocked())
                    Main.notify(_('Failed to unlock OTP secrets.'));
        }
        catch (e) {
            logError(e);
            Main.notifyError(_('Error unlocking OTP secrets.'), _(e.message));
        }
    }


    editTOTPSecrets()
    {
        this.#ext.openPreferences();
    }


    async refreshTOTPItems()
    {
        try {
            let secrets = await SecretUtils.getOTPItems();
            this.clearTOTPItems();
            secrets.forEach(x => {
                let totp = new TOTP(x.get_attributes());
                let label = makeLabel(totp);
                let item = this.menu.addAction(label,
                                               this.copyCode.bind(this, totp),
                                               'edit-copy-symbolic');
                this.#totp_items.push(item);
            });
        }
        catch (e) {
            logError(e);
            Main.notifyError(_('Error retrieving OTP items.'), _(e.message));
        }
    }


    clearTOTPItems()
    {
        this.#totp_items.forEach(x => x.destroy());
        this.#totp_items = [];
    }


    async copyCode(totp)
    {
        try {
            totp.secret = await SecretUtils.getSecret(totp);
            const code = totp.code();
            copyToClipboard(code);
        }
        catch (e) {
            logError(e);
            Main.notifyError(_('Error copying the OTP authentication code.'), _(e.message));
        }
    }

};
