# aedes-persistence

This repository is a fork from [moscajs/aedes-persistence](https://github.com/moscajs/aedes-persistence). 
The reason why the fork was necessary was that this repo is a dependency for [bolteu/aedes-persistence-redis](https://github.com/bolteu/aedes-persistence-redis) and contains tests that each persistence plugin should satisfy. As we removed wildcard support when making subscriptions, we had to fork this repo to remove the corresponding tests. Some other tests were added as well.
