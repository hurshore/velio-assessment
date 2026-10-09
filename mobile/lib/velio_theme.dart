import 'package:flutter/material.dart';

abstract final class VelioTheme {
  static const background = Color(0xfff3f3f4);
  static const brandDot = Color(0xff89cf43);
  static const disclosureBorder = RoundedRectangleBorder(
    borderRadius: BorderRadius.all(Radius.circular(16)),
    side: BorderSide(color: Color(0xffdedee2)),
  );
  static const lime = Color(0xffa3e75b);
  static const purple = Color(0xff8151d7);
  static const lavender = Color(0xffefe9fb);
  static ThemeData get theme => ThemeData(
    useMaterial3: true,
    scaffoldBackgroundColor: background,
    colorScheme: ColorScheme.fromSeed(seedColor: purple).copyWith(
      primary: purple,
      onPrimary: Colors.white,
      surface: Colors.white,
      onSurface: const Color(0xff0a0a0a),
      onSurfaceVariant: const Color(0xff606065),
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: background,
      surfaceTintColor: Colors.transparent,
      centerTitle: false,
    ),
    expansionTileTheme: const ExpansionTileThemeData(
      backgroundColor: Colors.white,
      collapsedBackgroundColor: Colors.white,
      shape: disclosureBorder,
      collapsedShape: disclosureBorder,
      clipBehavior: Clip.antiAlias,
      childrenPadding: EdgeInsets.fromLTRB(16, 0, 16, 16),
    ),
    textTheme: const TextTheme(
      headlineLarge: TextStyle(
        fontSize: 36,
        fontWeight: FontWeight.w800,
        height: 1.12,
        letterSpacing: -1.2,
      ),
      headlineMedium: TextStyle(
        fontSize: 30,
        fontWeight: FontWeight.w700,
        height: 1.15,
        letterSpacing: -.8,
      ),
      headlineSmall: TextStyle(fontSize: 24, fontWeight: FontWeight.w700),
      titleLarge: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
      bodyMedium: TextStyle(fontSize: 15, height: 1.5),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: lime,
        foregroundColor: const Color(0xff0a0a0a),
        minimumSize: const Size.fromHeight(52),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(48),
        padding: const EdgeInsets.all(16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.white,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(16)),
      contentPadding: const EdgeInsets.all(18),
    ),
    cardTheme: CardThemeData(
      color: Colors.white,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
    ),
  );
}
