/* extension.js
 * Copyright (C) 2025  Daniel K. O.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Indicator = Me.imports.indicator.Indicator;


class Extension {

    constructor(meta)
    {
        this.uuid = meta.uuid;
    }

    openPreferences()
    {
        ExtensionUtils.openPrefs();
    }

};


class TOTPExtension extends Extension {

    enable()
    {
        this._indicator = new Indicator(this);
    }

    disable()
    {
        this._indicator?.destroy();
        this._indicator = null;
    }

};


function init(meta)
{
    ExtensionUtils.initTranslations();
    return new TOTPExtension(meta);
}
