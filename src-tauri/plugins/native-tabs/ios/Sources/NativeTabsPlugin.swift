import Tauri
import UIKit
import WebKit

struct SelectArgs: Decodable {
  let id: String
}

struct TabArg: Decodable, Equatable {
  let id: String
  let symbol: String
}

struct ShowArgs: Decodable {
  let tabs: [TabArg]?
}

struct HiddenArgs: Decodable {
  let hidden: Bool
}

struct TintArgs: Decodable {
  let color: String
}

struct BadgeArgs: Decodable {
  let id: String
  let value: String?
}

/// Lets every touch through to the web view underneath except the ones that
/// land on the tab bar itself. The tab bar controller's own view covers the
/// whole screen — that is how it lays its bar out against the safe area — and
/// without this it would swallow every tap on the page.
private final class PassThroughView: UIView {
  weak var bar: UIView?

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard let hit = super.hitTest(point, with: event), let bar = bar else { return nil }
    return hit.isDescendant(of: bar) ? hit : nil
  }
}

/// The phone's tab bar, as iOS draws it for a real `UITabBarController`: four
/// tabs in one Liquid Glass bar and the add button as the search-role tab,
/// which iOS 26 sets apart as its own glass circle at the trailing end, lined
/// up with the bar by the system rather than by us.
///
/// The controller's pages are empty and transparent; the page is the web view
/// behind it. The bar only says what was tapped (`select`, and `add` for the
/// circle, which is never actually selected). Where that goes is the page's
/// business, and the page says back which tab is lit (`setSelected`).
class NativeTabsPlugin: Plugin, UITabBarControllerDelegate {
  private weak var webview: WKWebView?
  private var controller: UITabBarController?
  private var container: PassThroughView?
  /// The app's navy, the splash screen's ground.
  private var tint: UIColor = UIColor(hex: "#20294c")!

  /// Ids are the page's routes. Icons only: the four are few enough to be
  /// told apart by shape. The page sends its own list with `show`, so a
  /// change of tabs needs no rebuild; this is what is drawn if it does not.
  private var routes: [TabArg] = [
    TabArg(id: "overview", symbol: "square.grid.2x2"),
    TabArg(id: "transactions", symbol: "list.bullet.rectangle"),
    TabArg(id: "investments", symbol: "chart.line.uptrend.xyaxis"),
    TabArg(id: "cards", symbol: "creditcard"),
  ]

  override func load(webview: WKWebView) {
    self.webview = webview
  }

  private func emptyPage() -> UIViewController {
    let page = UIViewController()
    page.view.backgroundColor = .clear
    return page
  }

  /// Built on first use rather than in `load`, which runs before the web
  /// view has been put in its window.
  private func install() -> UITabBarController? {
    if let controller = controller { return controller }
    guard #available(iOS 18.0, *) else { return nil }
    guard let webview = webview, let host = webview.superview,
      let parent = manager.viewController
    else { return nil }

    let controller = UITabBarController(tabs: makeTabs())
    markProminent(controller)
    controller.delegate = self
    // A long press on the add circle is the manual form, straight away.
    let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
    hold.minimumPressDuration = 0.45
    controller.view.addGestureRecognizer(hold)
    controller.view.backgroundColor = .clear
    controller.view.tintColor = tint
    controller.tabBar.tintColor = tint

    let container = PassThroughView()
    container.translatesAutoresizingMaskIntoConstraints = false
    container.backgroundColor = .clear
    container.bar = controller.tabBar
    host.addSubview(container)
    NSLayoutConstraint.activate([
      container.leadingAnchor.constraint(equalTo: host.leadingAnchor),
      container.trailingAnchor.constraint(equalTo: host.trailingAnchor),
      container.topAnchor.constraint(equalTo: host.topAnchor),
      container.bottomAnchor.constraint(equalTo: host.bottomAnchor),
    ])

    parent.addChild(controller)
    controller.view.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(controller.view)
    NSLayoutConstraint.activate([
      controller.view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      controller.view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      controller.view.topAnchor.constraint(equalTo: container.topAnchor),
      controller.view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
    ])
    controller.didMove(toParent: parent)

    self.controller = controller
    self.container = container
    return controller
  }

  @available(iOS 18.0, *)
  private func makeTabs() -> [UITab] {
    let symbol = UIImage.SymbolConfiguration(pointSize: 17, weight: .medium)
    var tabs: [UITab] = routes.map { route in
      UITab(
        title: "",
        image: UIImage(systemName: route.symbol, withConfiguration: symbol),
        identifier: route.id
      ) { [weak self] _ in self?.emptyPage() ?? UIViewController() }
    }
    let add = UISearchTab { [weak self] _ in self?.emptyPage() ?? UIViewController() }
    add.title = ""
    add.image = UIImage(
      systemName: "plus",
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold))
    tabs.append(add)
    return tabs
  }

  /// iOS 26 sets the search tab apart on its own. iOS 27 only does that for
  /// the tab it is told is prominent, and otherwise draws it in the bar as a
  /// fifth item.
  @available(iOS 18.0, *)
  private func markProminent(_ controller: UITabBarController) {
    if #available(iOS 27.0, *),
      let add = controller.tabs.first(where: { $0 is UISearchTab })
    {
      controller.prominentTabIdentifier = add.identifier
    }
  }

  /// When the last long press on the add circle began. The tap UIKit may
  /// still deliver when it lifts is that press's, not a tap of its own.
  private var heldAt: Date?

  /// Whether a point in the controller's view is on the add circle. iOS draws
  /// it at the trailing end of the bar's row, about as wide as the bar is
  /// tall, so that end of the row is where it is.
  private func onAdd(_ point: CGPoint) -> Bool {
    guard let controller = controller else { return false }
    let bar = controller.tabBar
    let local = controller.view.convert(point, to: bar)
    guard bar.bounds.insetBy(dx: 0, dy: -12).contains(local) else { return false }
    let rtl = bar.effectiveUserInterfaceLayoutDirection == .rightToLeft
    let reach: CGFloat = 96
    return rtl ? local.x <= reach : local.x >= bar.bounds.width - reach
  }

  @objc private func held(_ gesture: UILongPressGestureRecognizer) {
    guard gesture.state == .began, let view = gesture.view else { return }
    guard onAdd(gesture.location(in: view)) else { return }
    heldAt = Date()
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    trigger("addLong", data: [:])
  }

  // MARK: - UITabBarControllerDelegate

  @available(iOS 18.0, *)
  func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
    if tab is UISearchTab {
      if let at = heldAt, Date().timeIntervalSince(at) < 3 {
        heldAt = nil
        return false
      }
      trigger("add", data: [:])
      return false
    }
    return true
  }

  @available(iOS 18.0, *)
  func tabBarController(
    _ tabBarController: UITabBarController, didSelectTab selectedTab: UITab, previousTab: UITab?
  ) {
    guard !(selectedTab is UISearchTab) else { return }
    trigger("select", data: ["id": selectedTab.identifier])
  }

  // MARK: - Commands

  /// Puts the bar up and answers with how much of the bottom of the screen it
  /// covers, home indicator included.
  @objc public func show(_ invoke: Invoke) {
    let wanted = (try? invoke.parseArgs(ShowArgs.self))?.tabs
    DispatchQueue.main.async {
      // The bar outlives a reload of the page, so a new list of tabs is
      // swapped into the one already up rather than waiting for a relaunch.
      var changed = false
      if let wanted = wanted, !wanted.isEmpty, wanted != self.routes {
        self.routes = wanted
        changed = true
      }
      guard let controller = self.install(), let container = self.container,
        let host = container.superview
      else {
        invoke.reject("No native tab bar here (needs iOS 18 and a web view in a window).")
        return
      }
      if changed, #available(iOS 18.0, *) {
        controller.setTabs(self.makeTabs(), animated: false)
        self.markProminent(controller)
      }
      container.isHidden = false
      container.alpha = 1
      host.bringSubviewToFront(container)
      host.layoutIfNeeded()
      let bar = controller.tabBar
      let covered = host.bounds.height - bar.convert(bar.bounds, to: host).minY
      invoke.resolve(["height": Double(covered)])
    }
  }

  @objc public func setSelected(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(SelectArgs.self) else {
      invoke.reject("setSelected needs an id.")
      return
    }
    DispatchQueue.main.async {
      if #available(iOS 18.0, *), let controller = self.controller,
        let tab = controller.tabs.first(where: { $0.identifier == args.id })
      {
        controller.selectedTab = tab
      }
      invoke.resolve()
    }
  }

  /// For what has to cover the whole screen — a sheet, the drawer — since the
  /// bar sits above the web view and would otherwise be drawn over it.
  @objc public func setHidden(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(HiddenArgs.self) else {
      invoke.reject("setHidden needs hidden.")
      return
    }
    DispatchQueue.main.async {
      guard let container = self.container else {
        invoke.resolve()
        return
      }
      if args.hidden {
        UIView.animate(withDuration: 0.18, animations: { container.alpha = 0 }) { _ in
          if container.alpha == 0 { container.isHidden = true }
        }
      } else {
        container.isHidden = false
        UIView.animate(withDuration: 0.22) { container.alpha = 1 }
      }
      invoke.resolve()
    }
  }

  /// The accent the selected tab and the add circle are drawn in, as `#rrggbb`.
  @objc public func setTint(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(TintArgs.self), let color = UIColor(hex: args.color)
    else {
      invoke.reject("setTint needs a #rrggbb color.")
      return
    }
    DispatchQueue.main.async {
      self.tint = color
      self.controller?.view.tintColor = color
      self.controller?.tabBar.tintColor = color
      invoke.resolve()
    }
  }

  @objc public func setBadge(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(BadgeArgs.self) else {
      invoke.reject("setBadge needs an id.")
      return
    }
    DispatchQueue.main.async {
      if #available(iOS 18.0, *),
        let tab = self.controller?.tabs.first(where: { $0.identifier == args.id })
      {
        tab.badgeValue = args.value?.isEmpty == false ? args.value : nil
      }
      invoke.resolve()
    }
  }
}

extension UIColor {
  convenience init?(hex: String) {
    let digits = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
    self.init(
      red: CGFloat((value >> 16) & 0xff) / 255,
      green: CGFloat((value >> 8) & 0xff) / 255,
      blue: CGFloat(value & 0xff) / 255,
      alpha: 1)
  }
}

@_cdecl("init_plugin_native_tabs")
func initPlugin() -> Plugin {
  return NativeTabsPlugin()
}
