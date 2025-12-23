/* indicator.js
 * Copyright (C) 2025  Daniel K. O.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const GObject = imports.gi.GObject;
const Secret  = imports.gi.Secret;
const St      = imports.gi.St;

const Main      = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const HOTP        = Me.imports.hotp.HOTP;
const SecretUtils = Me.imports.secretUtils;
const TOTP        = Me.imports.totp.TOTP;

const _ = ExtensionUtils.gettext;


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


var Indicator =
class Indicator extends PanelMenu.Button {

    static {
        GObject.registerClass(this);
    }


    #ext;
    #lock_item;
    #otp_items = [];
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
                                              this.lockOTPSecrets.bind(this),
                                              'changes-prevent-symbolic');

        this.#unlock_item = this.menu.addAction(_('Unlock OTP secrets...'),
                                                this.unlockOTPSecrets.bind(this),
                                                'changes-allow-symbolic');
        this.#unlock_item.visible = !this.#lock_item.visible;

        this.menu.addAction(_('Settings...'),
                            this.editOTPSecrets.bind(this),
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

        this.clearOTPItems();
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
                if (locked)
                    this.clearOTPItems();
                else
                    await this.refreshOTPItems();
            } else
                this.clearOTPItems();
        }
        catch (e) {
            logError(e);
        }
    }


    async lockOTPSecrets()
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


    async unlockOTPSecrets()
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


    editOTPSecrets()
    {
        this.#ext.openPreferences();
    }


    async refreshOTPItems()
    {
        try {
            let secrets = await SecretUtils.getOTPItems();
            this.clearOTPItems();
            secrets.forEach(x => {
                let otp = null;
                let args = x.get_attributes();
                if (args.type == 'TOTP')
                    otp = new TOTP(args);
                if (args.type == 'HOTP')
                    otp = new HOTP(args);
                if (otp == null)
                    throw Error(`BUG: args.type is ${args.type}`);
                let label = makeLabel(otp);
                let item = this.menu.addAction(label,
                                               this.copyCode.bind(this, otp),
                                               'edit-copy-symbolic');
                this.#otp_items.push(item);
            });
        }
        catch (e) {
            logError(e);
            Main.notifyError(_('Error retrieving OTP items.'), _(e.message));
        }
    }


    clearOTPItems()
    {
        this.#otp_items.forEach(x => x.destroy());
        this.#otp_items = [];
    }


    async copyCode(otp)
    {
        try {
            otp.secret = await SecretUtils.getSecret(otp);
            const code = otp.code();
            if (otp.type == 'HOTP') {
                const new_otp = otp.incremented();
                await SecretUtils.updateOTPItem(otp, new_otp);
            }
            copyToClipboard(code);
        }
        catch (e) {
            logError(e);
            Main.notifyError(_('Error copying the OTP authentication code.'), _(e.message));
        }
    }

};
