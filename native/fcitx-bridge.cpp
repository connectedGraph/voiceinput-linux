// MiMo's only injection path: one input-method commit, no clipboard or keys.
#include <fcitx/addonfactory.h>
#include <fcitx/addonmanager.h>
#include <fcitx/instance.h>
#include <fcitx/inputcontext.h>
#include <fcitx/inputcontextmanager.h>
#include <fcitx/event.h>
#include <fcitx-utils/dbus/bus.h>
#include <fcitx-utils/dbus/objectvtable.h>
#include <fcitx-utils/capabilityflags.h>
#include <sstream>
#include <iomanip>

class MimoBridge : public fcitx::AddonInstance,
                   public fcitx::dbus::ObjectVTable<MimoBridge> {
public:
    explicit MimoBridge(fcitx::Instance *instance)
        : instance_(instance), bus_(fcitx::dbus::BusType::Session) {
        bus_.attachEventLoop(&instance_->eventLoop());
        bus_.addObjectVTable("/org/voiceinput/MimoASR1", "org.voiceinput.MimoASR1", *this);
        if (!bus_.requestName("org.voiceinput.MimoASR1", fcitx::dbus::RequestNameFlag::None))
            throw std::runtime_error("MiMo bridge name is already in use");
        for (auto type : {fcitx::EventType::InputContextFocusIn,
                          fcitx::EventType::InputContextFocusOut}) {
            watchers_.push_back(instance_->watchEvent(type, fcitx::EventWatcherPhase::Default,
                [this](fcitx::Event &) { ++generation_; }));
        }
    }

    std::string capture() {
        auto *ic = instance_->inputContextManager().lastFocusedInputContext();
        if (!ic || !ic->hasFocus()) return {};
        std::ostringstream token;
        for (auto byte : ic->uuid()) token << std::hex << std::setw(2) << std::setfill('0') << int(byte);
        token << ':' << generation_;
        return token.str();
    }

    std::string commit(const std::string &text, const std::string &token) {
        if (text.empty()) return "EMPTY_TEXT";
        if (text.size() > 1024 * 1024) return "TEXT_TOO_LARGE";
        if (token.empty()) return "NO_INPUT_FOCUS";
        if (token != capture()) return "FOCUS_CHANGED";
        auto *ic = instance_->inputContextManager().lastFocusedInputContext();
        ic->commitString(text);
        return "OK";
    }

    std::string version() { return "1"; }

private:
    fcitx::Instance *instance_;
    fcitx::dbus::Bus bus_;
    uint64_t generation_ = 0;
    std::vector<std::unique_ptr<fcitx::HandlerTableEntry<fcitx::EventHandler>>> watchers_;
    FCITX_OBJECT_VTABLE_METHOD(capture, "Capture", "", "s");
    FCITX_OBJECT_VTABLE_METHOD(commit, "Commit", "ss", "s");
    FCITX_OBJECT_VTABLE_METHOD(version, "Version", "", "s");
};

class MimoFactory : public fcitx::AddonFactory {
public:
    fcitx::AddonInstance *create(fcitx::AddonManager *manager) override {
        return new MimoBridge(manager->instance());
    }
};
FCITX_ADDON_FACTORY_V2(mimoasr, MimoFactory)
