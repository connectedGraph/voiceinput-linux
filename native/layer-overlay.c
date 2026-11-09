// Electron renders the existing HUD; this noninteractive Wayland layer displays it.
// stdin framing: uint32 LE header size, JSON-free ASCII header, then payload.
// Header: "frame <png bytes> <logical width> <logical height> <top|bottom>"  (PNG, legacy)
//         "rawframe <bytes> <logical w> <logical h> <bmp w> <bmp h> <stride> <top|bottom>" (BGRA)
//         "hide"
#include <gtk/gtk.h>
#include <gtk-layer-shell.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>

static GtkWidget *window;
static cairo_surface_t *frame;
static GByteArray *input;
static int logical_width = 560, logical_height = 96;

static gboolean draw(GtkWidget *widget, cairo_t *cr, gpointer data) {
    (void)widget; (void)data;
    cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
    cairo_set_source_rgba(cr, 0, 0, 0, 0);
    cairo_paint(cr);
    if (frame) {
        cairo_scale(cr, (double)logical_width / cairo_image_surface_get_width(frame),
                        (double)logical_height / cairo_image_surface_get_height(frame));
        cairo_set_source_surface(cr, frame, 0, 0);
        cairo_paint(cr);
    }
    return TRUE;
}

typedef struct { const guint8 *bytes; gsize size, offset; } PngReader;
static cairo_status_t read_png(void *closure, unsigned char *out, unsigned int size) {
    PngReader *reader = closure;
    if (reader->offset + size > reader->size) return CAIRO_STATUS_READ_ERROR;
    memcpy(out, reader->bytes + reader->offset, size);
    reader->offset += size;
    return CAIRO_STATUS_SUCCESS;
}

static void parse_frames(void) {
    while (input->len >= 4) {
        uint32_t size = input->data[0] | (input->data[1] << 8) |
                        (input->data[2] << 16) | ((uint32_t)input->data[3] << 24);
        if (size > 256) { gtk_main_quit(); return; }
        if (input->len < 4 + size) return;
        char *header = g_strndup((char *)input->data + 4, size);
        unsigned int png_size = 0, raw_size = 0;
        int width = 0, height = 0, bmp_width = 0, bmp_height = 0, stride = 0;
        char position[16] = {0};
        if (!strcmp(header, "hide")) {
            gtk_widget_hide(window);
        } else if (sscanf(header, "rawframe %u %d %d %d %d %d %15s",
                          &raw_size, &width, &height, &bmp_width, &bmp_height, &stride, position) == 7 &&
                   raw_size <= 32 * 1024 * 1024 && width > 0 && width <= 2048 && height > 0 && height <= 1024 &&
                   bmp_width > 0 && bmp_width <= 4096 && bmp_height > 0 && bmp_height <= 2048 &&
                   stride >= bmp_width * 4 && stride <= bmp_width * 4 * 16) {
            if (input->len < 4 + size + raw_size) { g_free(header); return; }
            if ((size_t)stride * (size_t)bmp_height != raw_size) { g_free(header); gtk_main_quit(); return; }
            cairo_surface_t *next = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, bmp_width, bmp_height);
            if (cairo_surface_status(next) == CAIRO_STATUS_SUCCESS) {
                unsigned char *dst = cairo_image_surface_get_data(next);
                int dst_stride = cairo_image_surface_get_stride(next);
                const unsigned char *src = input->data + 4 + size;
                for (int y = 0; y < bmp_height; y++)
                    memcpy(dst + (size_t)y * dst_stride, src + (size_t)y * stride, (size_t)bmp_width * 4);
                cairo_surface_mark_dirty(next);
                if (frame) cairo_surface_destroy(frame);
                frame = next;
                logical_width = width; logical_height = height;
                gboolean top = !strcmp(position, "top");
                gtk_layer_set_anchor(GTK_WINDOW(window), GTK_LAYER_SHELL_EDGE_TOP, top);
                gtk_layer_set_anchor(GTK_WINDOW(window), GTK_LAYER_SHELL_EDGE_BOTTOM, !top);
                gtk_layer_set_margin(GTK_WINDOW(window), top ? GTK_LAYER_SHELL_EDGE_TOP : GTK_LAYER_SHELL_EDGE_BOTTOM, 64);
                gtk_widget_set_size_request(window, width, height);
                gtk_window_resize(GTK_WINDOW(window), width, height);
                gtk_widget_show_all(window);
                cairo_region_t *empty = cairo_region_create();
                gdk_window_input_shape_combine_region(gtk_widget_get_window(window), empty, 0, 0);
                cairo_region_destroy(empty);
                gtk_widget_queue_draw(window);
            } else cairo_surface_destroy(next);
        } else if (sscanf(header, "frame %u %d %d %15s", &png_size, &width, &height, position) == 4 &&
                   png_size <= 16 * 1024 * 1024 && width > 0 && width <= 2048 && height > 0 && height <= 1024) {
            if (input->len < 4 + size + png_size) { g_free(header); return; }
            PngReader reader = {input->data + 4 + size, png_size, 0};
            cairo_surface_t *next = cairo_image_surface_create_from_png_stream(read_png, &reader);
            if (cairo_surface_status(next) == CAIRO_STATUS_SUCCESS) {
                if (frame) cairo_surface_destroy(frame);
                frame = next;
                logical_width = width; logical_height = height;
                gboolean top = !strcmp(position, "top");
                gtk_layer_set_anchor(GTK_WINDOW(window), GTK_LAYER_SHELL_EDGE_TOP, top);
                gtk_layer_set_anchor(GTK_WINDOW(window), GTK_LAYER_SHELL_EDGE_BOTTOM, !top);
                gtk_layer_set_margin(GTK_WINDOW(window), top ? GTK_LAYER_SHELL_EDGE_TOP : GTK_LAYER_SHELL_EDGE_BOTTOM, 64);
                gtk_widget_set_size_request(window, width, height);
                gtk_window_resize(GTK_WINDOW(window), width, height);
                gtk_widget_show_all(window);
                cairo_region_t *empty = cairo_region_create();
                gdk_window_input_shape_combine_region(gtk_widget_get_window(window), empty, 0, 0);
                cairo_region_destroy(empty);
                gtk_widget_queue_draw(window);
            } else cairo_surface_destroy(next);
        } else { g_free(header); gtk_main_quit(); return; }
        g_byte_array_remove_range(input, 0, 4 + size + (raw_size ? raw_size : png_size));
        g_free(header);
    }
}

static gboolean receive(GIOChannel *channel, GIOCondition condition, gpointer data) {
    (void)channel; (void)data;
    guint8 buf[65536]; ssize_t size;
    while ((size = read(STDIN_FILENO, buf, sizeof(buf))) > 0) g_byte_array_append(input, buf, size);
    parse_frames();
    if (size == 0 || condition & (G_IO_HUP | G_IO_ERR)) { gtk_main_quit(); return FALSE; }
    return TRUE;
}

int main(int argc, char **argv) {
    g_set_prgname("mimo-asr-overlay");
    if (!gtk_init_check(&argc, &argv) || !gtk_layer_is_supported()) {
        fprintf(stderr, "Wayland layer-shell is unavailable\n"); return 1;
    }
    window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_decorated(GTK_WINDOW(window), FALSE);
    gtk_window_set_accept_focus(GTK_WINDOW(window), FALSE);
    gtk_widget_set_app_paintable(window, TRUE);
    GdkVisual *visual = gdk_screen_get_rgba_visual(gtk_widget_get_screen(window));
    if (visual) gtk_widget_set_visual(window, visual);
    gtk_layer_init_for_window(GTK_WINDOW(window));
    gtk_layer_set_namespace(GTK_WINDOW(window), "mimo-asr");
    gtk_layer_set_layer(GTK_WINDOW(window), GTK_LAYER_SHELL_LAYER_OVERLAY);
    gtk_layer_set_keyboard_mode(GTK_WINDOW(window), GTK_LAYER_SHELL_KEYBOARD_MODE_NONE);
    gtk_layer_set_exclusive_zone(GTK_WINDOW(window), 0);
    g_signal_connect(window, "draw", G_CALLBACK(draw), NULL);
    input = g_byte_array_new();
    fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);
    GIOChannel *channel = g_io_channel_unix_new(STDIN_FILENO);
    g_io_add_watch(channel, G_IO_IN | G_IO_HUP | G_IO_ERR, receive, NULL);
    puts("READY 2"); fflush(stdout);
    gtk_main();
    g_io_channel_unref(channel);
    g_byte_array_unref(input);
    if (frame) cairo_surface_destroy(frame);
    return 0;
}
