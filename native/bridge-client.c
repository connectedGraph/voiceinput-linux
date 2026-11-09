// An ELF client usable from desktop sessions whose PATH has no node.
#include <gio/gio.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    const char *method = argc > 1 ? argv[1] : "";
    if (strcmp(method, "Capture") && strcmp(method, "Commit") && strcmp(method, "Version")) return 2;
    GError *error = NULL;
    GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
    if (!bus) { fprintf(stderr, "%s\n", error->message); g_error_free(error); return 1; }
    GVariant *args = NULL;
    if (!strcmp(method, "Commit")) {
        if (argc != 3) return 2;
        GString *text = g_string_new(NULL);
        char buf[4096]; size_t count;
        while ((count = fread(buf, 1, sizeof(buf), stdin))) {
            g_string_append_len(text, buf, count);
            if (text->len > 1024 * 1024) return 2;
        }
        if (!g_utf8_validate(text->str, text->len, NULL)) return 2;
        args = g_variant_new("(ss)", text->str, argv[2]);
        g_string_free(text, TRUE);
    }
    GVariant *reply = g_dbus_connection_call_sync(bus, "org.voiceinput.MimoASR1",
        "/org/voiceinput/MimoASR1", "org.voiceinput.MimoASR1", method, args,
        G_VARIANT_TYPE("(s)"), G_DBUS_CALL_FLAGS_NO_AUTO_START, 2500, NULL, &error);
    if (!reply) { fprintf(stderr, "%s\n", error->message); g_error_free(error); g_object_unref(bus); return 1; }
    const char *value;
    g_variant_get(reply, "(&s)", &value);
    printf("%s\n", value);
    g_variant_unref(reply);
    g_object_unref(bus);
    return 0;
}
