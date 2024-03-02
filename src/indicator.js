/* indicator.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


// GI imports
const { Gio, GLib, GObject, St, Secret } = imports.gi;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const TOTP = Me.imports.src.totp;
const SecretUtils = Me.imports.src.secretUtils;

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


    constructor(uuid)
    {
        super();
        this._uuid = uuid;
        this._totp_items = [];
    }


    _init()
    {
        super._init(0.5, 'TOTP');

        let icon = new St.Icon(
                {
                    icon_name: 'changes-prevent-symbolic',
                    style_class: 'system-status-icon'
                }
        );
        this.add_child(icon);

        this._unlock_item = this.menu.addAction(_('Unlock keyring...'),
                                                this.unlockSecrets.bind(this),
                                               'changes-allow-symbolic');;

        this.menu.addAction(_('Edit secrets...'),
                            this.editSecrets.bind(this),
                           'document-edit-symbolic');


        Main.panel.addToStatusArea(this._uuid, this);
    }


    async _onOpenStateChanged(menu, is_open)
    {
        super._onOpenStateChanged(menu, is_open);

        try  {
            if (is_open) {
                this._unlock_item.visible = await SecretUtils.isCollectionLocked();
                this.addItems();
            } else
                this.clearItems();
        }
        catch (e) {
            logError(e, '_onOpenStateChanged()');
        }
    }


    async unlockSecrets()
    {
        try {
            await SecretUtils.unlockCollection();
        }
        catch (e) {
            logError(e, 'unlockSecrets()');
            Main.notifyError(_('Cannot unlock OTP keyring'), e.message);
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
            secrets.forEach(x => {
                let attributes = x.get_attributes();
                let label = makeLabel(attributes);
                this.addItem(label, attributes);
            });
        }
        catch (e) {
            logError(e, 'addSecretItems()');
            Main.notifyError(_('Cannot lookup OTP items'), e.message);
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
            let totp = new TOTP.TOTP(args);
            let code = totp.code();
            copyToClipboard(code);
        }
        catch (e) {
            logError(e, 'copyCode()');
            Main.notifyError(_('Failed to copy OTP code'), e.message);
        }
    }

};
