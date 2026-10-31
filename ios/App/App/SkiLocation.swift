import Capacitor
import CoreLocation
import UIKit

/// Registers the app's own plugins with the Capacitor bridge.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SkiLocationPlugin())
    }
}

/// Location for skiing with power modes chosen by the web layer:
///  - active: riding a piste, GPS at full accuracy
///  - lift:   on a lift (path is known), coarser GPS
///  - idle:   standing / in a hut, Wi-Fi/cell accuracy, wakes on movement
///  - saver:  off the slope (hotel, town, evening), GPS off, cell towers only
@objc(SkiLocationPlugin)
public class SkiLocationPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "SkiLocationPlugin"
    public let jsName = "SkiLocation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "battery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAlways", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]

    private var manager: CLLocationManager?
    private var mode = "active"
    private var running = false

    override public func load() {
        DispatchQueue.main.async {
            let m = CLLocationManager()
            m.delegate = self
            m.activityType = .fitness
            m.pausesLocationUpdatesAutomatically = false
            self.manager = m
            UIDevice.current.isBatteryMonitoringEnabled = true
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        let wanted = call.getString("mode") ?? "active"
        DispatchQueue.main.async {
            guard let m = self.manager else { call.reject("not ready"); return }
            self.mode = wanted
            self.running = true
            switch m.authorizationStatus {
            case .notDetermined: m.requestWhenInUseAuthorization()
            case .denied, .restricted: self.notifyListeners("error", data: ["code": "NOT_AUTHORIZED"])
            default: self.apply()
            }
            call.resolve(["auth": self.authName(m.authorizationStatus)])
        }
    }

    @objc func setMode(_ call: CAPPluginCall) {
        let wanted = call.getString("mode") ?? "active"
        DispatchQueue.main.async {
            if wanted != self.mode { self.mode = wanted; if self.running { self.apply() } }
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.running = false
            self.manager?.stopUpdatingLocation()
            self.manager?.stopMonitoringSignificantLocationChanges()
            call.resolve()
        }
    }

    @objc func battery(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let d = UIDevice.current
            let state: String
            switch d.batteryState {
            case .charging: state = "charging"
            case .full: state = "full"
            case .unplugged: state = "unplugged"
            default: state = "unknown"
            }
            call.resolve([
                "level": d.batteryLevel,
                "state": state,
                "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
                "mode": self.mode,
                "auth": self.authName(self.manager?.authorizationStatus ?? .notDetermined),
            ])
        }
    }

    @objc func requestAlways(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.manager?.requestAlwaysAuthorization()
            call.resolve()
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            call.resolve()
        }
    }

    private func apply() {
        guard let m = manager else { return }
        let authorized = [.authorizedAlways, .authorizedWhenInUse].contains(m.authorizationStatus)
        guard authorized else { return }
        m.allowsBackgroundLocationUpdates = true
        m.showsBackgroundLocationIndicator = true
        m.stopMonitoringSignificantLocationChanges()
        switch mode {
        case "lift":
            m.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
            m.distanceFilter = 20
        case "idle":
            m.desiredAccuracy = kCLLocationAccuracyHundredMeters
            m.distanceFilter = 30
        case "saver":
            m.desiredAccuracy = kCLLocationAccuracyKilometer
            m.distanceFilter = 250
            if CLLocationManager.significantLocationChangeMonitoringAvailable() {
                m.startMonitoringSignificantLocationChanges()
            }
        default:
            m.desiredAccuracy = kCLLocationAccuracyBest
            m.distanceFilter = 5
        }
        m.startUpdatingLocation()
    }

    private func authName(_ s: CLAuthorizationStatus) -> String {
        switch s {
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "whenInUse"
        case .denied, .restricted: return "denied"
        default: return "notDetermined"
        }
    }

    public func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        let name = authName(m.authorizationStatus)
        notifyListeners("auth", data: ["status": name])
        if name == "denied" { notifyListeners("error", data: ["code": "NOT_AUTHORIZED"]) }
        else if running { apply() }
    }

    public func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last else { return }
        notifyListeners("location", data: [
            "latitude": l.coordinate.latitude,
            "longitude": l.coordinate.longitude,
            "altitude": l.verticalAccuracy >= 0 ? l.altitude : NSNull(),
            "accuracy": l.horizontalAccuracy,
            "speed": l.speed >= 0 ? l.speed : NSNull(),
            "bearing": l.course >= 0 ? l.course : NSNull(),
            "time": l.timestamp.timeIntervalSince1970 * 1000,
        ])
    }

    public func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        if let e = error as? CLError, e.code == .denied { notifyListeners("error", data: ["code": "NOT_AUTHORIZED"]) }
    }
}
