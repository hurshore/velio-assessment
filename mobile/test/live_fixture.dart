import 'dart:async';
import 'dart:convert';

import 'package:velio_mobile/guest_live.dart';

class FixtureSocket implements LiveSocket {
  FixtureSocket(this.detail);
  final Map<String, dynamic> detail;
  final controller = StreamController<Object?>();
  final sent = <Map<String, dynamic>>[];
  @override
  Stream<Object?> get messages => controller.stream;
  void snapshot({Map<String, dynamic>? activity, String? eventId}) {
    final value = activity ?? detail;
    controller.add(
      jsonEncode({
        'type': 'snapshot',
        'eventId': eventId,
        'activityId': value['id'],
        'version': value['version'],
        'capacity': value['capacity'],
        'confirmedCount': value['confirmedCount'],
        'remainingSeats': value['remainingSeats'],
        'activity': {
          ...value,
          'inviteState':
              value['inviteState'] ??
              (value['remainingSeats'] == 0 ? 'full' : 'valid'),
        },
      }),
    );
  }

  @override
  void send(String message) {
    final data = jsonDecode(message) as Map<String, dynamic>;
    sent.add(data);
    if (data['type'] == 'subscribe') scheduleMicrotask(snapshot);
  }

  @override
  Future<void> close() async {
    if (!controller.isClosed) await controller.close();
  }
}

Map<String, dynamic> withParticipants(Map<String, dynamic> activity) => {
  ...activity,
  'participants': List.generate(
    activity['confirmedCount'] as int,
    (i) => {
      'id': '88888888-8888-4888-8888-${(i + 1).toString().padLeft(12, '0')}',
      'displayName': 'Participant ${i + 1}',
    },
  ),
};
