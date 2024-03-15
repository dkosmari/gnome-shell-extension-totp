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
const TOTP = Me.imports.src.totp.TOTP;

const _ = ExtensionUtils.gettext;


function copyToClipboard(text)
{
    // this runs inside gnome-shell, so we use St
    let clipboard = St.Clipboard.get_default();
    clipboard.set_text(St.ClipboardType.PRIMARY, text);
    clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
    Main.notify(_('OTP code copied.'), text);
}


function makeLabel({issuer, name})
{
    return `${issuer}: ${name}`;
}


var Indicator = class extends PanelMenu.Button {

    static {
        GObject.registerClass(this);
    }


    constructor(ext)
    {
        super();

        this._totp_items = [];

        let icon = new St.Icon(
            {
                icon_name: 'changes-prevent-symbolic',
                style_class: 'system-status-icon'
            }
        );
        this.add_child(icon);

        this._lock_item = this.menu.addAction(_('Lock the keyring...'),
                                              this.lockSecrets.bind(this),
                                              'changes-prevent-symbolic');

        this._unlock_item = this.menu.addAction(_('Unlock the keyring...'),
                                                this.unlockSecrets.bind(this),
                                                'changes-allow-symbolic');

        this.menu.addAction(_('Edit secrets...'),
                            this.editSecrets.bind(this),
                            'document-edit-symbolic');

        Main.panel.addToStatusArea(ext.uuid, this);
    }


    _init()
    {
        super._init(0.5, 'TOTP');
    }


    async _onOpenStateChanged(menu, is_open)
    {
        super._onOpenStateChanged(menu, is_open);

        try  {
            if (is_open) {
                let locked = await SecretUtils.isCollectionLocked();
                this._lock_item.visible = !locked;
                this._unlock_item.visible = locked;
                this.addItems();
            } else
                this.clearItems();
        }
        catch (e) {
            logError(e, '_onOpenStateChanged()');
        }
    }


    async lockSecrets()
    {
        try {
            if (!await SecretUtils.lockCollection())
                // Sometimes the keyring locks just fine, yet it reports incorrectly that
                // nothing was locked. So we double check here.
                if (!await SecretUtils.isCollectionLocked())
                    Main.notify(_('Failed to lock the OTP keyring.'));
        }
        catch (e) {
            logError(e, 'lockSecrets()');
            Main.notifyError(_('Error locking the OTP keyring.'), _(e.message));
        }
    }


    async unlockSecrets()
    {
        try {
            if (!await SecretUtils.unlockCollection())
                // Sometimes the keyring unlocks just fine, yet it reports incorrectly
                // that nothing was unlocked. So we double check here.
                if (await SecretUtils.isCollectionLocked())
                    Main.notify(_('Failed to unlock the OTP keyring.'));
        }
        catch (e) {
            logError(e, 'unlockSecrets()');
            Main.notifyError(_('Error unlocking the OTP keyring.'), _(e.message));
        }
    }


    editSecrets()
    {
        ExtensionUtils.openPrefs();
    }


    async addItems()
    {
        try {
            let secrets = await SecretUtils.getList();
            this.clearItems();
            secrets.forEach(x => {
                let attributes = x.get_attributes();
                let label = makeLabel(attributes);
                this.addItem(label, attributes);
            });
        }
        catch (e) {
            logError(e, 'addSecretItems()');
            Main.notifyError(_('Error retrieving OTP items.'), _(e.message));
        }
    }


    addItem(label, attributes)
    {
        let item = this.menu.addAction(label,
                                       this.copyCode.bind(this, attributes),
                                       'edit-copy-symbolic');

        this._totp_items.push(item);
    }


    clearItems()
    {
        this._totp_items.forEach(x => x.destroy());
        this._totp_items = [];
    }


    async copyCode(args)
    {
        try {
            args.secret = await SecretUtils.get(args);
            let totp = new TOTP(args);
            let code = totp.code();
            copyToClipboard(code);
        }
        catch (e) {
            logError(e, 'copyCode()');
            Main.notifyError(_('Error copying the OTP code.'), _(e.message));
        }
    }

};
