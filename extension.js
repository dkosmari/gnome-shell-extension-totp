/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import Indicator from './src/indicator.js';


export default
class TOTPExtension extends Extension {

    constructor(metadata)
    {
        super(metadata);
        this.initTranslations();
    }

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
