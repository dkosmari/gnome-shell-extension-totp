/* indicator.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


// GI imports
const {
    GObject,
    Secret,
    St
} = imports.gi;

const Main      = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const SecretUtils = Me.imports.src.secretUtils;
const TOTP        = Me.imports.src.totp.TOTP;

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


var Indicator = class extends PanelMenu.Button {

    static {
        GObject.registerClass(this);
    }


    #lock_item;
    #totp_items = [];
    #unlock_item;


    constructor(ext)
    {
        super();

        this.add_child(
            new St.Icon({
                icon_name: 'changes-prevent-symbolic',
                style_class: 'system-status-icon'
            })
        );

        this.#lock_item = this.menu.addAction(_('Lock OTP secrets'),
                                              this.lockTOTPSecrets.bind(this),
                                              'changes-prevent-symbolic');

        this.#unlock_item = this.menu.addAction(_('Unlock OTP secrets'),
                                                this.unlockTOTPSecrets.bind(this),
                                                'changes-allow-symbolic');
        this.#unlock_item.visible = !this.#lock_item.visible;

        this.menu.addAction(_('Edit OTP secrets...'),
                            this.editTOTPSecrets.bind(this),
                            'document-edit-symbolic');

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
            logError(e, '_onOpenStateChanged()');
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
            logError(e, 'lockTOTPSecrets()');
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
            logError(e, 'unlockTOTPSecrets()');
            Main.notifyError(_('Error unlocking OTP secrets.'), _(e.message));
        }
    }


    editTOTPSecrets()
    {
        ExtensionUtils.openPrefs();
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
            logError(e, 'refreshTOTPItems()');
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
            logError(e, 'copyCode()');
            Main.notifyError(_('Error copying the OTP authentication code.'), _(e.message));
        }
    }

};
