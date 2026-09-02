import UIKit

/// The entire hello-world fixture (ticket T10: "build a trivial hello app
/// once as a fixture within the repo"). A single UIViewController showing
/// static text -- no RN, no Hermes, no Metal/Skia -- so install.hello
/// measures simctl install cost against a genuinely minimal .app bundle,
/// contrasting with install.rig's much larger RN app.
@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = HelloViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

class HelloViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white

        let label = UILabel()
        label.text = "emu-bench hello"
        label.font = .systemFont(ofSize: 20, weight: .semibold)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)

        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }
}
