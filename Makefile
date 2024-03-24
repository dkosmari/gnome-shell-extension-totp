NAME := TOTP
UUID := totp@dkosmari.github.com
URL := https://github.com/dkosmari/gnome-shell-extension-totp


ZIP_FILE := $(UUID).shell-extension.zip

POT_NAME := po/$(UUID).pot
PO_FILES := $(wildcard po/*.po)

SOURCES := extension.js prefs.js
EXTRA_SOURCES := $(wildcard src/*.js)

GRESOURCE_XML := icons.gresource.xml
GRESOURCE_FILE := $(GRESOURCE_XML:.xml=)
EXTRA_DIST := \
	AUTHORS \
	COPYING \
	README.md \
	$(GRESOURCE_FILE)


.PHONY: all clean install update-po


all: $(ZIP_FILE)


clean:
	$(RM) $(ZIP_FILE)
	$(RM) $(GRESOURCE_FILE)


install: $(ZIP_FILE)
	gnome-extensions install --force $(ZIP_FILE)


$(ZIP_FILE): $(SOURCES) $(EXTRA_SOURCES) $(EXTRA_DIST) $(PO_FILES)
	gnome-extensions pack \
		--force \
		--podir=po \
		--extra-source=src \
		$(patsubst %,--extra-source=%,$(EXTRA_DIST))


%.gresource: %.gresource.xml $(shell glib-compile-resources --generate-dependencies $(GRESOURCE_XML))
	glib-compile-resources $< --target=$@


$(POT_NAME): $(SOURCES) $(EXTRA_SOURCES)
	xgettext \
		--from-code=UTF-8 \
		--copyright-holder="Daniel K. O." \
		--package-name="$(NAME)" \
		--msgid-bugs="$(URL)" \
		--output=$@ \
		$^


update-po: $(PO_FILES)


%.po: $(POT_NAME)
	msgmerge --update $@ $^
	touch $@

