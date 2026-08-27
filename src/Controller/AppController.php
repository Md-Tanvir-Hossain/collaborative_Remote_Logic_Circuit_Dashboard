<?php

namespace App\Controller;

use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Symfony\Component\HttpKernel\Attribute\AsController;
use Symfony\Component\Routing\Attribute\Route;

#[AsController]
class AppController
{
    private string $store;

    public function __construct()
    {
        $this->store = dirname(__DIR__, 2) . '/var/data';
        if (!is_dir($this->store)) {
            mkdir($this->store, 0775, true);
        }
    }

    #[Route('/', methods: ['GET'])]
    public function index(): Response
    {
        return new Response(file_get_contents(dirname(__DIR__, 2) . '/public/index.html'));
    }

    #[Route('/api/identity', methods: ['POST'])]
    public function identity(Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true) ?: [];
        $name = trim((string) ($body['name'] ?? '')) ?: 'Guest';
        $used = array_map(fn ($item) => $item['name'], $this->read('users.json', []));
        $assigned = $name;
        $suffix = 2;
        while (in_array($assigned, $used, true)) {
            $assigned = $name . ' ' . $suffix++;
        }
        $sessionId = bin2hex(random_bytes(8));
        $users = $this->read('users.json', []);
        $users[] = ['name' => $assigned, 'session' => $sessionId, 'lastSeen' => time()];
        $this->write('users.json', $users);
        return new JsonResponse(['assignedName' => $assigned, 'sessionId' => $sessionId]);
    }

    #[Route('/api/circuits', methods: ['GET'])]
    public function circuits(): JsonResponse
    {
        $this->removeStaleParticipants();
        return new JsonResponse(array_map(fn ($c) => [
            'id' => $c['id'], 'label' => $c['label'], 'gridSize' => $c['gridSize'],
            'participants' => count($c['participants']), 'maxParticipants' => 2,
            'createdAt' => $c['createdAt'],
        ], $this->read('circuits.json', [])));
    }

    #[Route('/api/circuits', methods: ['POST'])]
    public function create(Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true) ?: [];
        $circuits = $this->read('circuits.json', []);
        $id = count($circuits) ? max(array_column($circuits, 'id')) + 1 : 1;
        $circuit = ['id' => $id, 'label' => trim($body['label'] ?? '') ?: 'Untitled circuit',
            'gridSize' => max(10, min(40, (int) ($body['gridSize'] ?? 20))), 'createdAt' => date(DATE_ATOM), 'nextInputNumber' => 1, 'nextOutputNumber' => 1,
            'participants' => [], 'components' => [], 'wires' => [], 'events' => []];
        $circuits[] = $circuit;
        $this->write('circuits.json', $circuits);
        return new JsonResponse(['id' => $id]);
    }

    #[Route('/api/circuits/{id}', methods: ['GET'])]
    public function circuit(int $id): JsonResponse
    {
        $this->removeStaleParticipants();
        $circuit = $this->find($id);
        return $circuit ? new JsonResponse($circuit) : new JsonResponse(['error' => 'Circuit not found'], 404);
    }

    #[Route('/api/circuits/{id}/join', methods: ['POST'])]
    public function join(int $id, Request $request): JsonResponse
    {
        $this->removeStaleParticipants();
        $circuit = $this->find($id);
        $body = json_decode($request->getContent(), true) ?: [];
        if (!$circuit) {
            return new JsonResponse(['error' => 'Circuit not found'], 404);
        }
        $sessionId = $body['sessionId'] ?? '';
        if (count($circuit['participants']) >= 2 && !array_filter($circuit['participants'], fn ($participant) => $participant['session'] === $sessionId)) {
            return new JsonResponse(['error' => 'This circuit is full'], 409);
        }
        $participant = ['name' => trim($body['name'] ?? 'Guest'), 'session' => $sessionId ?: bin2hex(random_bytes(8)), 'lastSeen' => time()];
        $circuit['participants'] = array_values(array_filter($circuit['participants'], fn ($item) => $item['session'] !== $participant['session']));
        $circuit['participants'][] = $participant;
        $this->save($circuit);
        return new JsonResponse(['circuit' => $circuit]);
    }

    #[Route('/api/circuits/{id}/action', methods: ['POST'])]
    public function action(int $id, Request $request): JsonResponse
    {
        $circuit = $this->find($id);
        $payload = json_decode($request->getContent(), true) ?: [];
        if (!$circuit) {
            return new JsonResponse(['error' => 'Circuit not found'], 404);
        }
        $type = $payload['type'] ?? '';
        if ($type === 'component_added') {
            $component = $payload['component'] ?? [];
            if (in_array($component['type'] ?? '', ['INPUT', 'OUTPUT'], true)) {
                $counter = $component['type'] === 'INPUT' ? 'nextInputNumber' : 'nextOutputNumber';
                $prefix = $component['type'] === 'INPUT' ? 'INPUT' : 'OUTPUT';
                $circuit[$counter] = $circuit[$counter] ?? count(array_filter($circuit['components'], fn ($item) => $item['type'] === $component['type'])) + 1;
                $component['label'] = $prefix . str_pad((string) $circuit[$counter]++, 2, '0', STR_PAD_LEFT);
                $payload['component'] = $component;
            }
            $circuit['components'][] = $component;
        }
        if ($type === 'component_moved') {
            foreach ($circuit['components'] as &$component) {
                if ($component['id'] == $payload['id']) {
                    $component['x'] = $payload['x'];
                    $component['y'] = $payload['y'];
                }
            }
        }
        if ($type === 'component_removed') {
            $circuit['components'] = array_values(array_filter($circuit['components'], fn ($c) => $c['id'] != $payload['id']));
        }
        if ($type === 'input_toggled') {
            foreach ($circuit['components'] as &$component) {
                if ($component['id'] == $payload['id']) {
                    $component['state'] = (bool) $payload['state'];
                    $payload['label'] = $component['label'] ?? null;
                }
            }
        }
        if ($type === 'wire_added') {
            $wire = $payload['wire'] ?? [];
            $destinationCount = count(array_filter($circuit['wires'], fn ($item) => $item['to'] == ($wire['to'] ?? null)));
            $sourceCount = count(array_filter($circuit['wires'], fn ($item) => $item['from'] == ($wire['from'] ?? null)));
            $destination = array_values(array_filter($circuit['components'], fn ($component) => $component['id'] == ($wire['to'] ?? null)))[0] ?? null;
            $source = array_values(array_filter($circuit['components'], fn ($component) => $component['id'] == ($wire['from'] ?? null)))[0] ?? null;
            $destinationLimit = $destination && in_array($destination['type'], ['NOT', 'OUTPUT'], true) ? 1 : 2;
            if (!$source || !$destination || $source['type'] === 'OUTPUT' || $destination['type'] === 'INPUT' || $source['id'] === $destination['id']) {
                return new JsonResponse(['error' => 'That connection is not valid'], 422);
            }
            if ($destinationCount >= $destinationLimit) {
                return new JsonResponse(['error' => 'That input pin is already full'], 422);
            }
            if ($sourceCount >= 1) {
                return new JsonResponse(['error' => 'That output pin is already connected'], 422);
            }
            $circuit['wires'][] = $wire;
        }
        if ($type === 'wire_removed') {
            $circuit['wires'] = array_values(array_filter($circuit['wires'], fn ($w) => $w['id'] != $payload['id']));
        }
        $circuit['events'][] = ['id' => microtime(true), 'payload' => $payload];
        $circuit['events'] = array_slice($circuit['events'], -100);
        $this->save($circuit);
        return new JsonResponse($payload);
    }

    #[Route('/api/circuits/{id}/heartbeat', methods: ['POST'])]
    public function heartbeat(int $id, Request $request): JsonResponse
    {
        $this->removeStaleParticipants();
        $circuit = $this->find($id);
        $sessionId = (json_decode($request->getContent(), true) ?: [])['sessionId'] ?? '';
        if (!$circuit || !$sessionId) return new JsonResponse(['error' => 'Participant not found'], 404);
        $found = false;
        foreach ($circuit['participants'] as &$participant) {
            if ($participant['session'] === $sessionId) {
                $participant['lastSeen'] = time();
                $found = true;
            }
        }
        if (!$found) return new JsonResponse(['error' => 'Participant not found'], 404);
        $this->save($circuit);
        return new JsonResponse(['ok' => true]);
    }

    #[Route('/api/circuits/{id}/leave', methods: ['POST'])]
    public function leave(int $id, Request $request): JsonResponse
    {
        $circuit = $this->find($id);
        $sessionId = (json_decode($request->getContent(), true) ?: [])['sessionId'] ?? '';
        if (!$circuit) return new JsonResponse(['error' => 'Circuit not found'], 404);
        $circuit['participants'] = array_values(array_filter($circuit['participants'], fn ($participant) => $participant['session'] !== $sessionId));
        $circuit['events'][] = ['id' => microtime(true), 'payload' => ['type' => 'participant_left', 'sessionId' => $sessionId]];
        $this->save($circuit);
        return new JsonResponse(['ok' => true]);
    }

    #[Route('/api/circuits/{id}/events', methods: ['GET'])]
    public function events(int $id, Request $request): StreamedResponse
    {
        $last = (float) $request->headers->get('Last-Event-ID', 0);
        $started = microtime(true);
        $response = new StreamedResponse(function () use ($id, $last, $started) {
            while (microtime(true) - $started < 20) {
                $circuit = $this->find($id);
                foreach (($circuit['events'] ?? []) as $event) {
                    if ($event['id'] > $last) {
                        echo "id: {$event['id']}\ndata: " . json_encode($event['payload']) . "\n\n";
                        flush();
                        return;
                    }
                }
                echo ": heartbeat\n\n";
                flush();
                usleep(500000);
            }
        });
        $response->headers->set('Content-Type', 'text/event-stream');
        $response->headers->set('Cache-Control', 'no-cache');
        return $response;
    }

    private function find(int $id): ?array
    {
        foreach ($this->read('circuits.json', []) as $circuit) {
            if ($circuit['id'] === $id) {
                return $circuit;
            }
        } return null;
    }
    private function save(array $circuit): void
    {
        $all = $this->read('circuits.json', []);
        foreach ($all as $key => $item) {
            if ($item['id'] === $circuit['id']) {
                $all[$key] = $circuit;
            }
        } $this->write('circuits.json', $all);
    }
    private function read(string $file, array $fallback): array
    {
        $path = $this->store . '/' . $file;
        return file_exists($path) ? (json_decode(file_get_contents($path), true) ?: $fallback) : $fallback;
    }
    private function write(string $file, array $data): void
    {
        file_put_contents($this->store . '/' . $file, json_encode($data, JSON_PRETTY_PRINT), LOCK_EX);
    }

    private function removeStaleParticipants(): void
    {
        $now = time();
        $circuits = $this->read('circuits.json', []);
        foreach ($circuits as &$circuit) {
            $stale = array_filter($circuit['participants'], fn ($participant) => $now - ($participant['lastSeen'] ?? 0) > 30);
            $circuit['participants'] = array_values(array_filter($circuit['participants'], fn ($participant) => $now - ($participant['lastSeen'] ?? 0) <= 30));
            foreach ($stale as $participant) $circuit['events'][] = ['id' => microtime(true), 'payload' => ['type' => 'participant_left', 'sessionId' => $participant['session']]];
        }
        $this->write('circuits.json', $circuits);
    }
}
