package com.emubench.hello;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

/**
 * The entire hello-world fixture (ticket T10: "build a trivial hello app
 * once as a fixture within the repo"). A single Activity showing static
 * text -- no React Native, no Hermes, no dependencies beyond the Android
 * framework -- so install.hello measures adb/simctl install transport cost
 * against a genuinely minimal APK, in contrast with install.rig's much
 * larger (RN + Hermes bytecode + Skia/sqlite native libs) app.
 */
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView text = new TextView(this);
        text.setText("emu-bench hello");
        text.setTextSize(20);
        text.setPadding(48, 96, 48, 48);
        setContentView(text);
    }
}
