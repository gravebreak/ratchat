import type { HorseRaceEntry } from '../../../defs/def-games';

import { AppError } from '../../../utils/errors';
import { getOrdinalSuffix } from '../../../utils/format';
import { pickUniform } from '../../../utils/random';

type CommentaryLine = {
	commentary: string;
	singular: boolean;
	small: boolean;
	big: boolean;
};

enum ClusterType {
	Second,
	Middle,
	End
}

type HorseMovement = HorseRaceEntry & {
	surged: boolean;
	fell: boolean;
};

const BIG = 0.2;
const SMALL = 0.1;

const openingLines: CommentaryLine[] = [
	{ commentary: "and they're off!", singular: true, small: false, big: false },
	{ commentary: 'the gates fly open!', singular: true, small: false, big: false },
	{ commentary: 'here they go!', singular: true, small: false, big: false },
	{ commentary: 'and the race is underway!', singular: true, small: false, big: false },
	{ commentary: 'they break from the gates!', singular: true, small: false, big: false },
	{ commentary: "let'sago!", singular: true, small: false, big: false },
	{ commentary: 'and now some horse racing!', singular: true, small: false, big: false },
	{ commentary: 'the start gun fires!', singular: true, small: false, big: false },
	{ commentary: 'and in a flash, it begins!', singular: true, small: false, big: false },
	{ commentary: 'and the horses take off!', singular: true, small: false, big: false }
];

const corner1Lines: CommentaryLine[] = [
	{ commentary: 'they are rounding the first turn!', singular: true, small: false, big: false },
	{ commentary: 'here they come around the first turn!', singular: true, small: false, big: false },
	{ commentary: "we're a quarter through this race!", singular: true, small: false, big: false },
	{ commentary: 'one quarter down, three to go!', singular: true, small: false, big: false },
	{ commentary: 'the pack starts to round the corner!', singular: true, small: false, big: false },
	{ commentary: 'quarter mark reached!', singular: true, small: false, big: false },
	{ commentary: '30 seconds in!', singular: true, small: false, big: false },
	{ commentary: "that's half a minute down!", singular: true, small: false, big: false },
	{ commentary: "here's the first corner!", singular: true, small: false, big: false },
	{ commentary: 'what a start! here they come round the bend!', singular: true, small: false, big: false }
];

const midwayLines: CommentaryLine[] = [
	{ commentary: "we've reached halfway mark!", singular: true, small: false, big: false },
	{ commentary: 'the race is half over!', singular: true, small: false, big: false },
	{ commentary: "whoa, we're halfway there!", singular: true, small: false, big: false },
	{ commentary: 'a minute down, a minute to go!', singular: true, small: false, big: false },
	{ commentary: 'down the back stretch!', singular: true, small: false, big: false },
	{ commentary: "they're flat out!", singular: true, small: false, big: false },
	{ commentary: "they're going down the straightaway!", singular: true, small: false, big: false },
	{ commentary: "we're midway through this race!", singular: true, small: false, big: false },
	{ commentary: 'what a contest so far!', singular: true, small: false, big: false },
	{ commentary: 'get your last bets in!', singular: true, small: false, big: false }
];

const corner2Lines: CommentaryLine[] = [
	{ commentary: 'and into the far turn!', singular: true, small: false, big: false },
	{ commentary: "they're rounding the final corner!", singular: true, small: false, big: false },
	{ commentary: 'only 30 seconds left!', singular: true, small: false, big: false },
	{ commentary: 'half a minute to go!', singular: true, small: false, big: false },
	{ commentary: 'around the final bend!', singular: true, small: false, big: false },
	{ commentary: 'still a lot of racing left!', singular: true, small: false, big: false },
	{ commentary: 'three quarters down, one to go!', singular: true, small: false, big: false },
	{ commentary: 'the pack rounds the last corner!', singular: true, small: false, big: false },
	{ commentary: '30 seconds to mars - i mean the finish!', singular: true, small: false, big: false },
	{ commentary: 'almost done!', singular: true, small: false, big: false }
];

const finalStretchLines: CommentaryLine[] = [
	{ commentary: "they're entering the final stretch!", singular: true, small: false, big: false },
	{ commentary: 'the final sprint!', singular: true, small: false, big: false },
	{ commentary: 'the last push!', singular: true, small: false, big: false },
	{ commentary: 'approaching the finish!', singular: true, small: false, big: false },
	{ commentary: 'give it all you got!', singular: true, small: false, big: false },
	{ commentary: 'who is going to win?!', singular: true, small: true, big: false },
	{ commentary: "they're neck and neck!", singular: true, small: true, big: false },
	{ commentary: 'a race to the finish!', singular: true, small: true, big: false },
	{ commentary: "it's anyone's race!", singular: true, small: true, big: false },
	{ commentary: 'going to be a photo finish!', singular: true, small: true, big: false },
	{ commentary: 'this one might be buttoned up!', singular: true, small: false, big: true },
	{ commentary: "it'd take a miracle to change the outcome!", singular: true, small: false, big: true },
	{ commentary: 'this race might be over!', singular: true, small: false, big: true },
	{ commentary: 'well, we have a good idea of the winner already!', singular: true, small: false, big: true },
	{ commentary: 'too bad betting is closed!', singular: true, small: false, big: true }
];

const leadStart: CommentaryLine[] = [
	{ commentary: ' takes the lead!', singular: true, small: false, big: false },
	{ commentary: ' at the front of the pack!', singular: true, small: false, big: false },
	{ commentary: ' starts off strong!', singular: true, small: false, big: false },
	{ commentary: ' is in the lead!', singular: true, small: false, big: false },
	{ commentary: ' is the first out the gates!', singular: true, small: false, big: false },
	{ commentary: ' starts just ahead!', singular: true, small: true, big: false },
	{ commentary: ' gets a small edge to start!', singular: true, small: true, big: false },
	{ commentary: ' is just ahead of the others!', singular: true, small: true, big: false },
	{ commentary: ' starts a nose ahead!', singular: true, small: true, big: false },
	{ commentary: ' is just barely in front!', singular: true, small: true, big: false },
	{ commentary: ' has a big early lead!', singular: true, small: false, big: true },
	{ commentary: ' jumped way out in front!', singular: true, small: false, big: true },
	{ commentary: ' got way ahead!', singular: true, small: false, big: true },
	{ commentary: ' is out of the gates like a bullet!', singular: true, small: false, big: true },
	{ commentary: ' starts two lengths ahead!', singular: true, small: false, big: true }
];
const leadStable: CommentaryLine[] = [
	{ commentary: ' is still in the front!', singular: true, small: false, big: false },
	{ commentary: ' is comfortable with their position in front!', singular: true, small: false, big: false },
	{ commentary: " hasn't grown their lead!", singular: true, small: false, big: false },
	{ commentary: " hasn't lost any ground!", singular: true, small: false, big: false },
	{ commentary: ' is still ahead!', singular: true, small: false, big: false },
	{ commentary: ' is holding on by a thread still!', singular: true, small: true, big: false },
	{ commentary: ' is just a nose ahead!', singular: true, small: true, big: false },
	{ commentary: ' staying just out of reach!', singular: true, small: true, big: false },
	{ commentary: ' is barely hanging on!', singular: true, small: true, big: false },
	{ commentary: ' has a slight lead still!', singular: true, small: true, big: false },
	{ commentary: ' is way out in front still!', singular: true, small: false, big: true },
	{ commentary: ' is still over two lengths ahead!', singular: true, small: false, big: true },
	{ commentary: " isn't giving up any of that lead!", singular: true, small: false, big: true },
	{ commentary: ' looks dominant leading out there!', singular: true, small: false, big: true },
	{ commentary: ' is not growing their sizable lead!', singular: true, small: false, big: true }
];

const leadGrowing: CommentaryLine[] = [
	{ commentary: ' is trying to pull away!', singular: true, small: false, big: false },
	{ commentary: ' is widening the gap to second!', singular: true, small: false, big: false },
	{ commentary: ' wants to strengthen their lead!', singular: true, small: false, big: false },
	{ commentary: ' is adding distance to their lead!', singular: true, small: false, big: false },
	{ commentary: ' is breaking away from the pack!', singular: true, small: false, big: false },
	{ commentary: " has a small edge, but it's getting wider!", singular: true, small: true, big: false },
	{ commentary: ' is looking to add a little more to their lead!', singular: true, small: true, big: false },
	{ commentary: ' is just starting to pull away!', singular: true, small: true, big: false },
	{ commentary: ' wants a little more room!', singular: true, small: true, big: false },
	{ commentary: ' is just ahead but has the pace on second!', singular: true, small: true, big: false },
	{ commentary: ' is adding to their lead still! enough is never enough!', singular: true, small: false, big: true },
	{ commentary: ' is making their huge lead even huger!', singular: true, small: false, big: true },
	{ commentary: ' way out in front and not slowing down!', singular: true, small: false, big: true },
	{ commentary: ' wants to really widen the gap to second!', singular: true, small: false, big: true },
	{ commentary: ' has first place, but they might want the course record!', singular: true, small: false, big: true }
];
const leadShrinking: CommentaryLine[] = [
	{ commentary: ' is losing ground!', singular: true, small: false, big: false },
	{ commentary: ' has second closing in!', singular: true, small: false, big: false },
	{ commentary: ' starts to falter!', singular: true, small: false, big: false },
	{ commentary: "'s lead is shrinking!", singular: true, small: false, big: false },
	{ commentary: ' might be running out of gas!', singular: true, small: false, big: false },
	{ commentary: "'s lead might be gone soon!", singular: true, small: true, big: false },
	{ commentary: " won't be in first much longer!", singular: true, small: true, big: false },
	{ commentary: ' is just ahead, and losing ground!', singular: true, small: true, big: false },
	{ commentary: ' has second right on their heels!', singular: true, small: true, big: false },
	{ commentary: ' might lose first here!', singular: true, small: true, big: false },
	{ commentary: ' is coasting with their lead!', singular: true, small: false, big: true },
	{ commentary: ' lost a little ground but is still way out in front!', singular: true, small: false, big: true },
	{ commentary: ' has plenty of ground to give!', singular: true, small: false, big: true },
	{ commentary: ' can let off the throttle a little!', singular: true, small: false, big: true },
	{ commentary: " isn't worried about second catching up!", singular: true, small: false, big: true }
];
const leadNew: CommentaryLine[] = [
	{ commentary: ' TAKES THE LEAD!', singular: true, small: false, big: false },
	{ commentary: ' SNATCHES FIRST!', singular: true, small: false, big: false },
	{ commentary: ' TO THE FRONT OF THE PACK!', singular: true, small: false, big: false },
	{ commentary: ' IS THE NEW LEADER!', singular: true, small: false, big: false },
	{ commentary: ' JUMPS OUT IN FRONT!', singular: true, small: false, big: false },
	{ commentary: ' takes a small lead!', singular: true, small: true, big: false },
	{ commentary: ' pulls ahead by just a nose!', singular: true, small: true, big: false },
	{ commentary: ' is the new leader by a hair!', singular: true, small: true, big: false },
	{ commentary: ' took the lead, but for how long?', singular: true, small: true, big: false },
	{ commentary: ' is now just ahead!', singular: true, small: true, big: false },
	{ commentary: ' PUTS ON THE AFTERBURNERS AND TAKES FIRST!', singular: true, small: false, big: true },
	{ commentary: ' JUMPS WAY AHEAD OF THE PACK!', singular: true, small: false, big: true },
	{ commentary: ' PASSES EVERYONE IN A FLASH!', singular: true, small: false, big: true },
	{ commentary: ' IS THE NEW LEADER BY OVER TWO LENGTHS!', singular: true, small: false, big: true },
	{ commentary: ' IS OUT IN FRONT NOW, WITH A BIG LEAD!', singular: true, small: false, big: true }
];
const leadNewSurge: CommentaryLine[] = [
	{ commentary: ' CAME OUT OF NOWHERE TO TAKE FIRST!', singular: true, small: false, big: false },
	{ commentary: ' SURGES PAST EVERYONE ON THEIR WAY TO THE FRONT', singular: true, small: false, big: false },
	{ commentary: ' CAME FROM WAY BACK TO TAKE THE LEAD!', singular: true, small: false, big: false },
	{ commentary: ' BLEW PAST THE COMPETITION INTO FIRST!', singular: true, small: false, big: false },
	{ commentary: " CAN'T BE STOPPED ON THEIR WAY TO THE FRONT!", singular: true, small: false, big: false }
];

const clusterSecond: CommentaryLine[] = [
	{ commentary: ' is in second!', singular: true, small: false, big: false },
	{ commentary: ' is following the leader!', singular: true, small: false, big: false },
	{ commentary: ' is right behind!', singular: true, small: false, big: false },
	{ commentary: ' is next!', singular: true, small: false, big: false },
	{ commentary: ' is close to the front!', singular: true, small: false, big: false },
	{ commentary: " is breathing down the leader's neck!", singular: true, small: true, big: false },
	{ commentary: ' is just barely behind!', singular: true, small: true, big: false },
	{ commentary: " can't quite take first!", singular: true, small: true, big: false },
	{ commentary: ' is neck and neck with the leader!', singular: true, small: true, big: false },
	{ commentary: ' is almost in the lead!', singular: true, small: true, big: false },
	{ commentary: ' has a lot of ground to make up to take the lead!', singular: true, small: false, big: true },
	{ commentary: ' needs some extra oomf to get up to the leader!', singular: true, small: false, big: true },
	{ commentary: ' is looking at quite the gap to first!', singular: true, small: false, big: true },
	{ commentary: ' will need some help to pass the leader!', singular: true, small: false, big: true },
	{ commentary: ' is more than 2 lengths back from the leader!', singular: true, small: false, big: true },
	{ commentary: ' are just after first!', singular: false, small: false, big: false },
	{ commentary: ' are following the leader!', singular: false, small: false, big: false },
	{ commentary: ' are right behind!', singular: false, small: false, big: false },
	{ commentary: ' are next!', singular: false, small: false, big: false },
	{ commentary: ' are close to the front!', singular: false, small: false, big: false },
	{ commentary: " are breathing down the leader's neck!", singular: false, small: true, big: false },
	{ commentary: ' are just barely behind!', singular: false, small: true, big: false },
	{ commentary: " can't quite take first!", singular: false, small: true, big: false },
	{ commentary: ' are neck and neck with the leader!', singular: false, small: true, big: false },
	{ commentary: ' are almost in the lead!', singular: false, small: true, big: false },
	{ commentary: ' have a lot of ground to make up to take the lead!', singular: false, small: false, big: true },
	{ commentary: ' need some extra oomf to get up to the leader!', singular: false, small: false, big: true },
	{ commentary: ' are looking at quite the gap to first!', singular: false, small: false, big: true },
	{ commentary: ' will need some help to pass the leader!', singular: false, small: false, big: true },
	{ commentary: ' are more than 2 lengths back from the leader!', singular: false, small: false, big: true }
];
const clusterMiddle: CommentaryLine[] = [
	{ commentary: ' is next after that!', singular: true, small: false, big: false },
	{ commentary: ' is coming up next!', singular: true, small: false, big: false },
	{ commentary: ' is in the scrum!', singular: true, small: false, big: false },
	{ commentary: ' is in the middle of the field!', singular: true, small: false, big: false },
	{ commentary: " can't separate from the pack!", singular: true, small: false, big: false },
	{ commentary: ' is just a smidge behind!', singular: true, small: true, big: false },
	{ commentary: ' is behind by just a nose!', singular: true, small: true, big: false },
	{ commentary: ' is keeping it competitive!', singular: true, small: true, big: false },
	{ commentary: ' is close enough to move up!', singular: true, small: true, big: false },
	{ commentary: ' might pass a horse or two!', singular: true, small: true, big: false },
	{ commentary: ' has a lot of ground to cover to the horses ahead!', singular: true, small: false, big: true },
	{ commentary: ' is looking at quite a gap to the group ahead!', singular: true, small: false, big: true },
	{ commentary: ' might not be able to catch the horses in front!', singular: true, small: false, big: true },
	{ commentary: ' has fallen behind the pack ahead!', singular: true, small: false, big: true },
	{ commentary: ' is two lengths behind that!', singular: true, small: false, big: true },
	{ commentary: ' are next after that!', singular: false, small: false, big: false },
	{ commentary: ' are coming up next!', singular: false, small: false, big: false },
	{ commentary: ' are in the scrum!', singular: false, small: false, big: false },
	{ commentary: ' are in the middle of the field!', singular: false, small: false, big: false },
	{ commentary: " can't separate from the pack!", singular: false, small: false, big: false },
	{ commentary: ' are just a smidge behind!', singular: false, small: true, big: false },
	{ commentary: ' are behind by just a nose!', singular: false, small: true, big: false },
	{ commentary: ' are keeping it competitive!', singular: false, small: true, big: false },
	{ commentary: ' are close enough to move up!', singular: false, small: true, big: false },
	{ commentary: ' might pass a horse or two!', singular: false, small: true, big: false },
	{ commentary: ' have a lot of ground to cover to the horses ahead!', singular: false, small: false, big: true },
	{ commentary: ' are looking at quite a gap to the group ahead!', singular: false, small: false, big: true },
	{ commentary: ' might not be able to catch the horses in front!', singular: false, small: false, big: true },
	{ commentary: ' have fallen behind the pack ahead!', singular: false, small: false, big: true },
	{ commentary: ' are two lengths behind that!', singular: false, small: false, big: true }
];

const clusterEnd: CommentaryLine[] = [
	{ commentary: ' is bringing up the rear!', singular: true, small: false, big: false },
	{ commentary: ' is sitting at the back of the pack!', singular: true, small: false, big: false },
	{ commentary: ' has a great view of the race from the back!', singular: true, small: false, big: false },
	{ commentary: ' is waiting to make their move!', singular: true, small: false, big: false },
	{ commentary: "'s in last!", singular: true, small: false, big: false },
	{ commentary: ' is biding their time at the back!', singular: true, small: true, big: false },
	{ commentary: ' is at the back but is still in it!', singular: true, small: true, big: false },
	{ commentary: ' waits for the time to strike!', singular: true, small: true, big: false },
	{ commentary: ' is saving their energy!', singular: true, small: true, big: false },
	{ commentary: ' might surge from behind late!', singular: true, small: true, big: false },
	{ commentary: ' has a lot of distance to cover to the rest of the race!', singular: true, small: false, big: true },
	{ commentary: ' is way behind!', singular: true, small: false, big: true },
	{ commentary: " isn't competitive this race!", singular: true, small: false, big: true },
	{ commentary: ' should probably just retire!', singular: true, small: false, big: true },
	{ commentary: ' might have given up!', singular: true, small: false, big: true },
	{ commentary: ' are bringing up the rear!', singular: false, small: false, big: false },
	{ commentary: ' are sitting at the back of the pack!', singular: false, small: false, big: false },
	{ commentary: ' have a great view of the race from the back!', singular: false, small: false, big: false },
	{ commentary: ' are waiting to make their move!', singular: false, small: false, big: false },
	{ commentary: ' are in last together!', singular: false, small: false, big: false },
	{ commentary: ' are biding their time at the back!', singular: false, small: true, big: false },
	{ commentary: ' are at the back but are still in it!', singular: false, small: true, big: false },
	{ commentary: ' wait for the time to strike!', singular: false, small: true, big: false },
	{ commentary: ' are saving their energy!', singular: false, small: true, big: false },
	{ commentary: ' might surge from behind late!', singular: false, small: true, big: false },
	{ commentary: ' have a lot of distance to cover to the rest of the race!', singular: false, small: false, big: true },
	{ commentary: ' are way behind!', singular: false, small: false, big: true },
	{ commentary: " aren't competitive this race!", singular: false, small: false, big: true },
	{ commentary: ' should probably just retire!', singular: false, small: false, big: true },
	{ commentary: ' might have given up!', singular: false, small: false, big: true }
];

const surgeLines: CommentaryLine[] = [
	{ commentary: ' surges ahead of ', singular: true, small: false, big: false },
	{ commentary: ' finally makes their move to pass ', singular: true, small: false, big: false },
	{ commentary: ' has a sudden burst of energy to move past ', singular: true, small: false, big: false },
	{ commentary: ' rockets ahead of ', singular: true, small: false, big: false },
	{ commentary: ' jumps in front of ', singular: true, small: false, big: false },
	{ commentary: ' shoots forward of ', singular: true, small: false, big: false },
	{ commentary: ' surges onward, leaving behind ', singular: true, small: false, big: false },
	{ commentary: ' finds a burst of speed to pass ', singular: true, small: false, big: false },
	{ commentary: ' speeds up and overtakes ', singular: true, small: false, big: false },
	{ commentary: ' zips past ', singular: true, small: false, big: false }
];
const fallLines: CommentaryLine[] = [
	{ commentary: ' is flaming out!', singular: true, small: false, big: false },
	{ commentary: ' loses a lot of steam!', singular: true, small: false, big: false },
	{ commentary: " can't keep up!", singular: true, small: false, big: false },
	{ commentary: ' loses ground!', singular: true, small: false, big: false },
	{ commentary: " doesn't have the endurance to keep up!", singular: true, small: false, big: false },
	{ commentary: ' loses a lot of ground!', singular: true, small: false, big: false },
	{ commentary: ' lost interest in the racing!', singular: true, small: false, big: false },
	{ commentary: ' started daydreaming!', singular: true, small: false, big: false },
	{ commentary: ' stumbled!', singular: true, small: false, big: false },
	{ commentary: ' needs a breather!', singular: true, small: false, big: false }
];

const finishFirst: CommentaryLine[] = [
	{ commentary: ' TAKES HOME THE ROSES!', singular: true, small: false, big: false },
	{ commentary: ' WINS IT ALL!', singular: true, small: false, big: false },
	{ commentary: ' IS THE WINNER!', singular: true, small: false, big: false },
	{ commentary: ' CROSSES THE LINE FIRST!', singular: true, small: false, big: false },
	{ commentary: ' COMES IN FIRST!', singular: true, small: false, big: false },
	{ commentary: ' JUST BARELY WINS IT!', singular: true, small: true, big: false },
	{ commentary: ' BY A NOSE!', singular: true, small: true, big: false },
	{ commentary: ' EEKS OUT THE WIN!', singular: true, small: true, big: false },
	{ commentary: ' WINS IN A PHOTO FINISH!', singular: true, small: true, big: false },
	{ commentary: ' TAKES IT AT THE LAST SECOND!', singular: true, small: true, big: false },
	{ commentary: ' WINS COMFORTABLY!', singular: true, small: false, big: true },
	{ commentary: ' GETS A WELL DESERVED WIN!', singular: true, small: false, big: true },
	{ commentary: ' TAKES FIRST EASILY!', singular: true, small: false, big: true },
	{ commentary: ' WINS WITH NO CONTEST!', singular: true, small: false, big: true },
	{ commentary: ' CROSSES THE LINE WELL AHEAD OF SECOND!', singular: true, small: false, big: true }
];
const finishSecond: CommentaryLine[] = [
	{ commentary: ' takes second!', singular: true, small: false, big: false },
	{ commentary: ' wins the silver medal!', singular: true, small: false, big: false },
	{ commentary: ' just behind the leader!', singular: true, small: false, big: false },
	{ commentary: ' finishes in second place!', singular: true, small: false, big: false },
	{ commentary: ' is the second horse to cross!', singular: true, small: false, big: false },
	{ commentary: ' JUST LOST BY A NOSE!', singular: true, small: true, big: false },
	{ commentary: " DIDN'T QUITE GET THERE IN THE END!", singular: true, small: true, big: false },
	{ commentary: ' FELL BEHIND THE LEADER AT THE LAST SECOND!', singular: true, small: true, big: false },
	{ commentary: ' TAKES SECOND IN A TIGHT RACE!', singular: true, small: true, big: false },
	{ commentary: ' LOSES THE PHOTO FINISH!', singular: true, small: true, big: false },
	{ commentary: ' follows up a little later!', singular: true, small: false, big: true },
	{ commentary: ' crosses a few heartbeats after!', singular: true, small: false, big: true },
	{ commentary: ' still places well with second!', singular: true, small: false, big: true },
	{ commentary: ' goes home first loser!', singular: true, small: false, big: true },
	{ commentary: " takes second, but didn't have a shot at first!", singular: true, small: false, big: true }
];
const finishThird: CommentaryLine[] = [
	{ commentary: ' takes third!', singular: true, small: false, big: false },
	{ commentary: ' wins the bronze medal!', singular: true, small: false, big: false },
	{ commentary: ' just behind first and second!', singular: true, small: false, big: false },
	{ commentary: ' finishes in third place!', singular: true, small: false, big: false },
	{ commentary: ' is the third horse to cross!', singular: true, small: false, big: false },
	{ commentary: " didn't quite get second!", singular: true, small: true, big: false },
	{ commentary: ' misses second by a nose!', singular: true, small: true, big: false },
	{ commentary: ' takes third in a tight race!', singular: true, small: true, big: false },
	{ commentary: ' puts in a valiant effort but gets third!', singular: true, small: true, big: false },
	{ commentary: ' almost got second at the end!', singular: true, small: true, big: false },
	{ commentary: ' is happy with a podium finish!', singular: true, small: false, big: true },
	{ commentary: ' is lucky to get third!', singular: true, small: false, big: true },
	{ commentary: " didn't really have a shot at second!", singular: true, small: false, big: true },
	{ commentary: ' was still a solid bet!', singular: true, small: false, big: true },
	{ commentary: ' tried their best and got third!', singular: true, small: false, big: true }
];

export function createHorseStartCommentary(curr: HorseRaceEntry[]): string[] {
	const opener = pickUniform(openingLines.map(line => line.commentary));
	const commentary: string[] = [opener];

	const leaderGap = curr[0].score - curr[1].score;
	const leaderCandidates = filterCommentaryPool(leadStart, leaderGap, true);
	const leaderLine = appendHorseNames([curr[0].horseName]) + pickUniform(leaderCandidates.map(line => line.commentary));
	commentary.push(leaderLine);

	const movementArray = curr.slice(1).map(entry => ({ ...entry, surged: false, fell: false }));
	const clusters = createHorseClusters(movementArray);
	const endCluster = clusters.pop();
	if(clusters.length > 0){
		const secondCluster = clusters[0];
		const secondGap = curr[0].score - secondCluster[0].score;
		const secondLine = createClusterCommentary(secondCluster, secondGap, ClusterType.Second);
		commentary.push(secondLine);

		for(let clusterIndex = 1; clusterIndex < clusters.length; clusterIndex++){
			const cluster = clusters[clusterIndex];
			const previousCluster = clusters[clusterIndex - 1];
			const gap = previousCluster[previousCluster.length - 1].score - cluster[0].score;
			const line = createClusterCommentary(cluster, gap, ClusterType.Middle);
			commentary.push(line);
		}
	}

	if(endCluster && endCluster.length > 0 ){
		let endGap: number;
		if(clusters.length > 0){
			const lastBeforeCluster = clusters[clusters.length - 1];
			endGap = lastBeforeCluster[lastBeforeCluster.length - 1].score - endCluster[0].score;
		}
		else{
			endGap = curr[0].score - endCluster[0].score;
		}
		const endLine = createClusterCommentary(endCluster, endGap, ClusterType.End);
		commentary.push(endLine);
	}

	return commentary;
}

export function createHorseCommentary(curr: HorseRaceEntry[], prev: HorseRaceEntry[], phase: number): string[] {
	let locationPool: CommentaryLine[];
	switch(phase){
		case 2:{
			locationPool = corner1Lines;
			break;
		}
		case 3:{
			locationPool = midwayLines;
			break;
		}
		case 4:{
			locationPool = corner2Lines;
			break;
		}
		case 5:{
			locationPool = finalStretchLines;
			break;
		}
		default:{
			throw new AppError('createHorseCommentary called with unexpected phase', 'bug');
		}
	}
	const leaderGap = curr[0].score - curr[1].score;
	const locationCandidates = filterCommentaryPool(locationPool, leaderGap, true);

	const opener = pickUniform(locationCandidates.map(line => line.commentary));
	const commentary: string[] = [opener];

	const movementArray = createHorseMovementArray(curr, prev);

	const sameLeader = curr[0].horseName === prev[0].horseName;
	let leaderPool: CommentaryLine[];
	if(sameLeader){
		if(curr[1].score < prev[1].score){
			leaderPool = leadGrowing;
		}
		else if(curr[1].score > prev[1].score){
			leaderPool = leadShrinking;
		}
		else{
			leaderPool = leadStable;
		}
	}
	else{
		if(movementArray[0].surged){
			leaderPool = leadNewSurge;
		}
		else{
			leaderPool = leadNew;
		}
	}
	const leaderCandidates = filterCommentaryPool(leaderPool, leaderGap, true);
	const leaderLine = appendHorseNames([curr[0].horseName]) + pickUniform(leaderCandidates.map(line => line.commentary));
	commentary.push(leaderLine);

	const clusters = createHorseClusters(movementArray.slice(1));
	const endCluster = clusters.pop();

	if(clusters.length > 0){
		const secondCluster = clusters[0];
		const secondGap = curr[0].score - secondCluster[0].score;

		if(secondCluster[0].surged){
			let nextCluster = clusters[1];
			if(!nextCluster && endCluster){
				nextCluster = endCluster;
			}
			const surgeLine = createSurgeCommentary(secondCluster[0], nextCluster);
			commentary.push(surgeLine);
		}
		else{
			const secondLine = createClusterCommentary(secondCluster, secondGap, ClusterType.Second);
			commentary.push(secondLine);
		}

		for(let clusterIndex = 1; clusterIndex < clusters.length; clusterIndex++){
			const cluster = clusters[clusterIndex];
			const previousCluster = clusters[clusterIndex - 1];
			const gap = previousCluster[previousCluster.length - 1].score - cluster[0].score;

			if(cluster[0].surged){
				let nextCluster = clusters[clusterIndex + 1];
				if(!nextCluster && endCluster){
					nextCluster = endCluster;
				}
				const surgeLine = createSurgeCommentary(cluster[0], nextCluster ?? []);
				commentary.push(surgeLine);
				continue;
			}
			if(cluster[0].fell){
				const fallLine = createFallCommentary(cluster[0]);
				commentary.push(fallLine);
				continue;
			}

			const line = createClusterCommentary(cluster, gap, ClusterType.Middle);
			commentary.push(line);
		}
	}

	if(endCluster && endCluster.length > 0){
		for(const endEntry of endCluster){
			if(endEntry.fell){
				const fallLine = createFallCommentary(endEntry);
				commentary.push(fallLine);
			}
		}

		let endGap: number;
		if(clusters.length > 0){
			const lastBeforeCluster = clusters[clusters.length - 1];
			endGap = lastBeforeCluster[lastBeforeCluster.length - 1].score - endCluster[0].score;
		}
		else{
			endGap = curr[0].score - endCluster[0].score;
		}
		const endLine = createClusterCommentary(endCluster, endGap, ClusterType.End);
		commentary.push(endLine);
	}

	return commentary;
}

export function createHorseEndCommentary(curr: HorseRaceEntry[]): string[] {
	const commentary: string[] = [];

	const firstGap = curr[0].score - curr[1].score;
	const firstCandidates = filterCommentaryPool(finishFirst, firstGap, true);
	const firstLine = appendHorseNames([curr[0].horseName]) + pickUniform(firstCandidates.map(line => line.commentary));
	commentary.push(firstLine);

	const secondGap = curr[0].score - curr[1].score;
	const secondCandidates = filterCommentaryPool(finishSecond, secondGap, true);
	const secondLine = appendHorseNames([curr[1].horseName]) + pickUniform(secondCandidates.map(line => line.commentary));
	commentary.push(secondLine);

	const thirdGap = curr[1].score - curr[2].score;
	const thirdCandidates = filterCommentaryPool(finishThird, thirdGap, true);
	const thirdLine = appendHorseNames([curr[2].horseName]) + pickUniform(thirdCandidates.map(line => line.commentary));
	commentary.push(thirdLine);

	for(let index = 3; index < curr.length; index++){
		const place = index + 1;
		const line = `[${curr[index].horseName}] finishes ${place}${getOrdinalSuffix(place)}.`;
		commentary.push(line);
	}

	return commentary;
}

function filterCommentaryPool(pool: CommentaryLine[], gap: number, singular: boolean): CommentaryLine[] {
	const close = gap < SMALL;
	const far = gap > BIG;

	const candidates = pool.filter(line => {
		if(line.singular !== singular){
			return false;
		}
		if(line.small && !close){
			return false;
		}
		if(line.big && !far){
			return false;
		}
		return true;
	});
	return candidates;
}

function createClusterCommentary(input: HorseRaceEntry[], gap: number, type: ClusterType): string {
	let pool: CommentaryLine[];
	switch(type){
		case ClusterType.Second:{
			pool = clusterSecond;
			break;
		}
		case ClusterType.Middle:{
			pool = clusterMiddle;
			break;
		}
		case ClusterType.End:{
			pool = clusterEnd;
			break;
		}
	}

	const singular = input.length < 2;
	const candidates = filterCommentaryPool(pool, gap, singular);

	const chosen = pickUniform(candidates.map(line => line.commentary));
	const names = input.map(entry => entry.horseName);
	const line = appendHorseNames(names) + chosen;
	return line;
}

function createSurgeCommentary(entry: HorseMovement, nextCluster: HorseMovement[]): string {
	const surgeCandidates = filterCommentaryPool(surgeLines, 0, true);
	const chosen = pickUniform(surgeCandidates.map(line => line.commentary));

	let passedNames: string;
	if(nextCluster.length === 0){
		passedNames = 'no one!';
	}
	else{
		passedNames = appendHorseNames(nextCluster.map(passedEntry => passedEntry.horseName));
	}
	const horse = appendHorseNames([entry.horseName]);
	const line = horse + chosen + passedNames;
	return line;
}

function createFallCommentary(entry: HorseMovement): string {
	const fallCandidates = filterCommentaryPool(fallLines, 0, true);
	const chosen = pickUniform(fallCandidates.map(line => line.commentary));
	const horse = appendHorseNames([entry.horseName]);
	const line = horse + chosen;
	return line;
}

function createHorseMovementArray(curr: HorseRaceEntry[], prev: HorseRaceEntry[]): HorseMovement[] {
	const movementArray: HorseMovement[] = [];

	for(const entry of curr){
		const prevEntry = prev.find(prevCandidate => prevCandidate.horseName === entry.horseName);
		if(!prevEntry){
			throw new AppError('no matching previous entry found for horse during movement tagging', 'bug');
		}

		const delta = entry.score - prevEntry.score;
		const surged = delta > BIG;
		const fell = delta < -BIG;

		const taggedEntry: HorseMovement = {
			...entry,
			surged: surged,
			fell: fell
		};
		movementArray.push(taggedEntry);
	}

	return movementArray;
}

function createHorseClusters(horses: HorseMovement[]): HorseMovement[][] {
	let endStart = horses.length;
	for(let index = 0; index < horses.length; index++){
		if(horses[index].score < 0.3){
			endStart = index;
			break;
		}
	}

	const clusters: HorseMovement[][] = [];
	const beforeClusters = horses.slice(0, endStart);
	const endCluster = horses.slice(endStart);

	let anchorIndex = 0;
	while(anchorIndex < beforeClusters.length){
		const anchor = beforeClusters[anchorIndex];

		if(anchor.surged || anchor.fell){
			clusters.push([anchor]);
			anchorIndex++;
			continue;
		}

		const cluster: HorseMovement[] = [anchor];
		let nextIndex = anchorIndex + 1;
		while(
			nextIndex < beforeClusters.length &&
			!beforeClusters[nextIndex].surged &&
			!beforeClusters[nextIndex].fell &&
			anchor.score - beforeClusters[nextIndex].score <= SMALL
		){
			cluster.push(beforeClusters[nextIndex]);
			nextIndex++;
		}

		clusters.push(cluster);
		anchorIndex = nextIndex;
	}

	clusters.push(endCluster);
	return clusters;
}

function appendHorseNames(names: string[]): string {
	if(names.length === 1){
		return `[${names[0]}]`;
	}

	if(names.length === 2){
		return `[${names[0]}] and [${names[1]}]`;
	}

	const allButLast = names.slice(0, -1).map(name => `[${name}]`).join(', ');
	const last = names[names.length - 1];
	return `${allButLast}, and [${last}]`;
}
