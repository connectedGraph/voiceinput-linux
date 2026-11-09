// Test-only clipboard owner. Offers image + HTML + text + binary in one selection.
#include <gtk/gtk.h>
#include <stdio.h>
typedef struct { gchar *mime; guchar *data; gsize size; } FixtureTarget;
static GPtrArray *targets;
static guint n_targets;
static GtkTargetEntry *entries;
static const unsigned char binary[] = {0, 255, 13, 10, 128, 0, 42};
static void provide(GtkClipboard *clipboard, GtkSelectionData *selection, guint info, gpointer data) {
    (void)clipboard; (void)data;
    FixtureTarget *target = g_ptr_array_index(targets, info);
    gtk_selection_data_set(selection, gtk_selection_data_get_target(selection), 8, target->data, target->size);
}
static void cleared(GtkClipboard *clipboard, gpointer data) { (void)clipboard; (void)data; gtk_main_quit(); }
int main(int argc, char **argv) {
    if (argc != 2) return 1;
    targets = g_ptr_array_new_with_free_func(g_free);
    if (g_str_has_prefix(argv[1], "--restore=")) {
        gchar *manifest = NULL;
        if (!g_file_get_contents(argv[1] + 10, &manifest, NULL, NULL)) return 1;
        gchar **lines = g_strsplit(manifest, "\n", -1);
        for (guint i = 0; lines[i] && *lines[i]; i++) {
            gchar **parts = g_strsplit(lines[i], "\t", 2);
            FixtureTarget *target = g_new0(FixtureTarget, 1);
            target->mime = g_strdup(parts[0]);
            if (!parts[1] || !g_file_get_contents(parts[1], (gchar **)&target->data, &target->size, NULL)) return 1;
            g_ptr_array_add(targets, target);
            n_targets++;
            g_strfreev(parts);
        }
        g_strfreev(lines); g_free(manifest);
    } else {
        FixtureTarget *formats[] = {
            &(FixtureTarget){"image/png", NULL, 0}, &(FixtureTarget){"text/html", NULL, 0},
            &(FixtureTarget){"text/plain;charset=utf-8", NULL, 0}, &(FixtureTarget){"application/x-mimo-binary", NULL, 0}
        };
        const gchar *values[] = {NULL, "<b>图片与 HTML</b>", "剪贴板原始文本", NULL};
        gsize png_size = 0;
        if (!g_file_get_contents(argv[1], (gchar **)&formats[0]->data, &png_size, NULL)) return 1;
        formats[0]->size = png_size;
        formats[1]->data = (guchar *)values[1]; formats[1]->size = strlen(values[1]);
        formats[2]->data = (guchar *)values[2]; formats[2]->size = strlen(values[2]);
        formats[3]->data = (guchar *)binary; formats[3]->size = sizeof(binary);
        for (guint i = 0; i < G_N_ELEMENTS(formats); i++) { g_ptr_array_add(targets, formats[i]); n_targets++; }
    }
    if (!n_targets) return 0;
    entries = g_new0(GtkTargetEntry, n_targets);
    for (guint i = 0; i < n_targets; i++) {
        FixtureTarget *target = g_ptr_array_index(targets, i);
        entries[i] = (GtkTargetEntry){target->mime, 0, i};
    }
    gtk_init(&argc, &argv);
    GtkClipboard *clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
    if (!gtk_clipboard_set_with_data(clipboard, entries, n_targets, provide, cleared, NULL)) return 1;
    puts("READY"); fflush(stdout);
    gtk_main();
    return 0;
}
